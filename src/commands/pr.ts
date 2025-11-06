import { isInsideGitRepo, getGitRoot } from "../utils/git";

export interface PrOptions {
  branch?: string;
  silent?: boolean;
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
  const { silent = false } = options;
  const log = silent ? () => {} : console.log;
  const error = silent ? () => {} : console.error;
  
  // Check if in a git repository
  if (!(await isInsideGitRepo(process.cwd()))) {
    error("ⓘ Not in a git repository. Please run this command inside a git repo.");
    throw new Error("Not in a git repository");
  }
  
  const gitRoot = await getGitRoot(process.cwd());
  if (!gitRoot) {
    error("ⓘ Failed to determine the root of the git repository.");
    throw new Error("Could not find git root");
  }
  
  // Check if git-filter-repo is installed
  if (!(await checkGitFilterRepo())) {
    error("ⓘ git-filter-repo is not installed. Please install it via Homebrew: brew install git-filter-repo");
    throw new Error("git-filter-repo not installed");
  }
  
  try {
    // Get current branch
    const currentBranch = await getCurrentBranch(gitRoot);
    
    // Determine PR branch name
    const prBranch = options.branch || `${currentBranch}--PR`;
    
    log(`Creating PR branch: ${prBranch}`);
    
    // Create or reset PR branch from current branch
    await createOrResetBranch(gitRoot, currentBranch, prBranch);
    
    log("Filtering branch to remove AGENTS.md and CLAUDE.md from history...");
    
    // Run git-filter-repo to remove files from history on the PR branch
    const proc = Bun.spawn([
      "git",
      "filter-repo",
      "--path", "AGENTS.md",
      "--path", "CLAUDE.md",
      "--invert-paths",
      "--force",
      "--refs", "HEAD",
      "^origin/main"
    ], {
      cwd: gitRoot,
      stdout: silent ? "pipe" : "inherit",
      stderr: silent ? "pipe" : "inherit",
    });
    
    await proc.exited;
    
    if (proc.exitCode !== 0) {
      const stderr = silent ? await new Response(proc.stderr).text() : "";
      error("ⓘ Failed to filter repository");
      if (silent && stderr) {
        error(stderr);
      }
      throw new Error("git-filter-repo failed");
    }
    
    log(`\n✓ PR branch ${prBranch} is ready!`);
    log(`  Current branch: ${prBranch}`);
    log(`  AGENTS.md and CLAUDE.md have been removed from this branch's history`);
    log(`  Your original ${currentBranch} branch is untouched`);
    log(`  You can now push this branch and create a pull request.`);
    
  } catch (err) {
    error("Error creating PR branch:", err);
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
  branch            Target branch name (defaults to current branch + '--PR')

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages

Examples:
  agency pr                      # Create PR branch with default name
  agency pr feature-pr           # Create PR branch with custom name
  agency pr --silent             # Create PR branch without output
  agency pr --help               # Show this help message

Notes:
  - PR branch is created from your current branch (not main)
  - AGENTS.md and CLAUDE.md are removed from history using git-filter-repo
  - Original branch is never modified
  - If PR branch exists, it will be deleted and recreated
  - Uses --force flag (be careful with this command!)
`;
