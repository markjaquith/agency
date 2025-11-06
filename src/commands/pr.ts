import { isInsideGitRepo, getGitRoot } from "../utils/git";
import { loadConfig } from "../config";
import { makePrBranchName, extractSourceBranch } from "../utils/pr-branch";

export interface PrOptions {
  branch?: string;
  silent?: boolean;
  force?: boolean;
}

async function getCurrentBranch(gitRoot: string): Promise<string> {
  const proc = Bun.spawn(["git", "branch", "--show-current"], {
    cwd: gitRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  
  await proc.exited;
  
  if (proc.exitCode !== 0) {
    throw new Error("Failed to get current branch");
  }
  
  const output = await new Response(proc.stdout).text();
  return output.trim();
}

async function branchExists(gitRoot: string, branch: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "rev-parse", "--verify", branch], {
    cwd: gitRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  
  await proc.exited;
  return proc.exitCode === 0;
}

async function checkGitFilterRepo(): Promise<boolean> {
  const proc = Bun.spawn(["which", "git-filter-repo"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  
  await proc.exited;
  return proc.exitCode === 0;
}

async function getBaseBranch(gitRoot: string, currentBranch: string): Promise<string | null> {
  // Try to find the upstream branch
  const upstreamProc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", `${currentBranch}@{upstream}`], {
    cwd: gitRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  
  await upstreamProc.exited;
  
  if (upstreamProc.exitCode === 0) {
    const upstream = await new Response(upstreamProc.stdout).text();
    return upstream.trim();
  }
  
  // Try common base branches in order
  const commonBases = ["origin/main", "origin/master", "main", "master"];
  
  for (const base of commonBases) {
    const exists = await branchExists(gitRoot, base);
    if (exists) {
      return base;
    }
  }
  
  return null;
}

async function getMergeBase(gitRoot: string, branch1: string, branch2: string): Promise<string> {
  const proc = Bun.spawn(["git", "merge-base", branch1, branch2], {
    cwd: gitRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  
  await proc.exited;
  
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to find merge base: ${stderr}`);
  }
  
  const output = await new Response(proc.stdout).text();
  return output.trim();
}

async function createOrResetBranch(gitRoot: string, sourceBranch: string, targetBranch: string): Promise<void> {
  const exists = await branchExists(gitRoot, targetBranch);
  
  if (exists) {
    // Delete and recreate the branch
    await Bun.spawn(["git", "branch", "-D", targetBranch], {
      cwd: gitRoot,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
  }
  
  // Create new branch from source
  const proc = Bun.spawn(["git", "checkout", "-b", targetBranch, sourceBranch], {
    cwd: gitRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  
  await proc.exited;
  
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create branch: ${stderr}`);
  }
}

export async function pr(options: PrOptions = {}): Promise<void> {
  const { silent = false, force = false } = options;
  const log = silent ? () => {} : console.log;
  
  // Check if in a git repository
  if (!(await isInsideGitRepo(process.cwd()))) {
    throw new Error("Not in a git repository. Please run this command inside a git repo.");
  }
  
  const gitRoot = await getGitRoot(process.cwd());
  if (!gitRoot) {
    throw new Error("Failed to determine the root of the git repository.");
  }
  
  // Check if git-filter-repo is installed
  if (!(await checkGitFilterRepo())) {
    throw new Error("git-filter-repo is not installed. Please install it via Homebrew: brew install git-filter-repo");
  }
  
  // Load config
  const config = await loadConfig();
  
  try {
    // Get current branch
    const currentBranch = await getCurrentBranch(gitRoot);
    
    // Check if current branch looks like a PR branch already
    const possibleSourceBranch = extractSourceBranch(currentBranch, config.prBranch);
    if (possibleSourceBranch && !force) {
      // Check if the possible source branch exists
      const sourceExists = await branchExists(gitRoot, possibleSourceBranch);
      if (sourceExists) {
        throw new Error(
          `Current branch '${currentBranch}' appears to be a PR branch for '${possibleSourceBranch}'.\n` +
          `Creating a PR branch from a PR branch is likely a mistake.\n` +
          `Use --force to override this check.`
        );
      }
    }
    
    // Find the base branch this was created from
    const baseBranch = await getBaseBranch(gitRoot, currentBranch);
    
    if (!baseBranch) {
      throw new Error("Could not determine base branch. Tried: origin/main, origin/master, main, master");
    }
    
    // Get the merge-base (where the branch diverged)
    const mergeBase = await getMergeBase(gitRoot, currentBranch, baseBranch);
    
    // Determine PR branch name using config pattern
    const prBranch = options.branch || makePrBranchName(currentBranch, config.prBranch);
    
    log(`Creating PR branch: ${prBranch}`);
    log(`Base branch: ${baseBranch}`);
    
    // Create or reset PR branch from current branch
    await createOrResetBranch(gitRoot, currentBranch, prBranch);
    
    // Run git-filter-repo to remove files from history on the PR branch
    // Only filter commits after the merge-base
    const proc = Bun.spawn([
      "git",
      "filter-repo",
      "--path", "AGENTS.md",
      "--path", "CLAUDE.md",
      "--invert-paths",
      "--force",
      "--refs", "HEAD",
      `^${mergeBase}`
    ], {
      cwd: gitRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    
    await proc.exited;
    
    if (proc.exitCode !== 0) {
      throw new Error("git-filter-repo failed");
    }
    
    log(`✓ PR branch ${prBranch} is ready!`);
    
  } catch (err) {
    // Re-throw errors for CLI handler to display
    throw err;
  }
}

export const help = `
Usage: agency pr [branch] [options]

Create a PR branch from the current branch with AGENTS.md and CLAUDE.md removed from history.

This command creates a new branch (or recreates it if it exists) based on your current
branch, then uses git-filter-repo to remove AGENTS.md and CLAUDE.md from the branch's
history. Your original branch remains completely untouched.

Prerequisites:
  - git-filter-repo must be installed: brew install git-filter-repo

Arguments:
  branch            Target branch name (defaults to pattern from config)

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -f, --force       Force PR branch creation even if current branch looks like a PR branch

Configuration:
  ~/.config/agency/agency.json can contain:
  {
    "prBranch": "%branch%--PR"  // Pattern for PR branch names
  }
  
  Use %branch% as placeholder for source branch name.
  If %branch% is not present, pattern is treated as a suffix.
  
  Examples:
    "%branch%--PR" -> feature-foo becomes feature-foo--PR
    "PR/%branch%" -> feature-foo becomes PR/feature-foo
    "--PR" -> feature-foo becomes feature-foo--PR

Examples:
  agency pr                      # Create PR branch with default name
  agency pr feature-pr           # Create PR branch with custom name
  agency pr --force              # Force creation even from a PR branch
  agency pr --silent             # Create PR branch without output
  agency pr --help               # Show this help message

Notes:
  - PR branch is created from your current branch (not main)
  - AGENTS.md and CLAUDE.md are removed from history using git-filter-repo
  - Original branch is never modified
  - If PR branch exists, it will be deleted and recreated
  - Command will refuse to create PR branch from a PR branch unless --force is used
`;
