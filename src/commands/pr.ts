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

async function checkoutBranch(gitRoot: string, branch: string, create: boolean = false, force: boolean = false): Promise<void> {
  const args = create 
    ? ["git", "checkout", "-b", branch] 
    : force 
      ? ["git", "checkout", "-f", branch]
      : ["git", "checkout", branch];
      
  const proc = Bun.spawn(args, {
    cwd: gitRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  
  await proc.exited;
  
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to checkout branch: ${stderr}`);
  }
}

async function cherryPickCommits(gitRoot: string, baseBranch: string, targetBranch: string): Promise<void> {
  // Get commits that are in targetBranch but not in baseBranch
  const proc = Bun.spawn(["git", "log", "--pretty=format:%H", `${baseBranch}..${targetBranch}`], {
    cwd: gitRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  
  await proc.exited;
  
  if (proc.exitCode !== 0) {
    return; // No commits to cherry-pick
  }
  
  const output = await new Response(proc.stdout).text();
  const commits = output.trim().split("\n").filter(c => c).reverse(); // Oldest first
  
  for (const commit of commits) {
    const cherryProc = Bun.spawn(["git", "cherry-pick", commit], {
      cwd: gitRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    
    await cherryProc.exited;
    
    if (cherryProc.exitCode !== 0) {
      // If cherry-pick fails, try to continue
      await Bun.spawn(["git", "cherry-pick", "--abort"], {
        cwd: gitRoot,
      }).exited;
    }
  }
}

async function removeFilesFromBranch(gitRoot: string): Promise<void> {
  // Remove AGENTS.md and CLAUDE.md if they exist
  const files = ["AGENTS.md", "CLAUDE.md"];
  
  for (const file of files) {
    const proc = Bun.spawn(["git", "rm", "--cached", "-f", file], {
      cwd: gitRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    
    await proc.exited;
    // Ignore errors - file might not exist
  }
  
  // Commit the removal if there are changes
  const statusProc = Bun.spawn(["git", "diff", "--cached", "--quiet"], {
    cwd: gitRoot,
  });
  
  await statusProc.exited;
  
  if (statusProc.exitCode !== 0) {
    // There are staged changes
    const commitProc = Bun.spawn(["git", "commit", "-m", "Remove AGENTS.md and CLAUDE.md"], {
      cwd: gitRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    
    await commitProc.exited;
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
  
  try {
    // Get current branch
    const currentBranch = await getCurrentBranch(gitRoot);
    
    // Determine PR branch name
    const prBranch = options.branch || `${currentBranch}--PR`;
    
    log(`Creating PR branch: ${prBranch}`);
    
    // Check if PR branch already exists
    const prBranchExists = await branchExists(gitRoot, prBranch);
    
    if (prBranchExists) {
      log(`PR branch ${prBranch} already exists, updating it...`);
      
      // Checkout PR branch
      await checkoutBranch(gitRoot, prBranch);
      
      // Reset to the base (assuming main)
      const resetProc = Bun.spawn(["git", "reset", "--hard", "main"], {
        cwd: gitRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      
      await resetProc.exited;
      
      // Cherry-pick commits from current branch
      await cherryPickCommits(gitRoot, "main", currentBranch);
    } else {
      // Create new PR branch from main
      await checkoutBranch(gitRoot, "main", false, true); // Force checkout main
      await checkoutBranch(gitRoot, prBranch, true);
      
      // Cherry-pick commits from current branch
      await cherryPickCommits(gitRoot, "main", currentBranch);
    }
    
    // Remove AGENTS.md and CLAUDE.md from the PR branch
    await removeFilesFromBranch(gitRoot);
    
    log(`\n✓ PR branch ${prBranch} is ready!`);
    log(`  Current branch: ${prBranch}`);
    log(`  You can now push this branch and create a pull request.`);
    
  } catch (err) {
    error("Error creating PR branch:", err);
    throw err;
  }
}

export const help = `
Usage: agency pr [branch] [options]

Create a PR branch based on the current branch without AGENTS.md/CLAUDE.md.

This command creates or updates a branch that mirrors your current branch but
with AGENTS.md and CLAUDE.md removed from git tracking. This allows you to
create pull requests without these personal files.

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
  - PR branch is created from main branch
  - Commits from current branch are cherry-picked
  - AGENTS.md and CLAUDE.md are removed in a final commit
  - If PR branch exists, it will be updated
`;
