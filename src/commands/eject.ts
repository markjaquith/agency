import { resolve } from "path";
import { isInsideGitRepo, getGitRoot } from "../utils/git";

export interface EjectOptions {
  path?: string;
  silent?: boolean;
}

export async function eject(options: EjectOptions = {}): Promise<void> {
  const { silent = false } = options;
  const log = silent ? () => {} : console.log;
  const error = silent ? () => {} : console.error;
  
  let targetPath: string;
  
  if (options.path) {
    targetPath = resolve(options.path);
  } else {
    // If no path provided, use git root of current directory
    if (!(await isInsideGitRepo(process.cwd()))) {
      error("ⓘ Not in a git repository. Please run this command inside a git repo.");
      throw new Error("Not in a git repository");
    }
    
    const gitRoot = await getGitRoot(process.cwd());
    if (!gitRoot) {
      error("ⓘ Failed to determine the root of the git repository.");
      throw new Error("Could not find git root");
    }
    
    targetPath = gitRoot;
  }
  
  try {
    // Remove files from git index
    const filesToRemove = ["AGENTS.md", "CLAUDE.md"];
    
    for (const file of filesToRemove) {
      const proc = Bun.spawn(["git", "rm", "--cached", file], {
        cwd: targetPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      
      await proc.exited;
      
      if (proc.exitCode === 0) {
        log(`Removed ${file} from git index`);
      } else {
        // File might not be tracked, which is fine
        const stderr = await new Response(proc.stderr).text();
        if (!stderr.includes("did not match any files")) {
          log(`ⓘ ${file} was not tracked by git`);
        }
      }
    }
    
    // Check if .gitignore exists
    const gitignorePath = resolve(targetPath, ".gitignore");
    const gitignoreFile = Bun.file(gitignorePath);
    
    let gitignoreContent = "";
    if (await gitignoreFile.exists()) {
      gitignoreContent = await gitignoreFile.text();
    }
    
    // Add entries to .gitignore if not already present
    const entries = ["AGENTS.md", "CLAUDE.md"];
    let modified = false;
    
    for (const entry of entries) {
      if (!gitignoreContent.includes(entry)) {
        gitignoreContent += (gitignoreContent && !gitignoreContent.endsWith("\n") ? "\n" : "") + entry + "\n";
        modified = true;
      }
    }
    
    if (modified) {
      await Bun.write(gitignorePath, gitignoreContent);
      log("Updated .gitignore");
    } else {
      log("ⓘ .gitignore already contains AGENTS.md and CLAUDE.md");
    }
    
    log("\nEject complete!");
  } catch (err) {
    error("Error during eject:", err);
    throw err;
  }
}

export const help = `
Usage: agency eject [path] [options]

Remove AGENTS.md and CLAUDE.md from git tracking and add them to .gitignore.

This command removes the files from the git index (keeping the local copies)
and adds them to .gitignore so they won't be tracked in future commits.

Arguments:
  path              Path to git repository root (defaults to current repo root)

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages

Examples:
  agency eject                   # Eject files in current git repo
  agency eject ./my-project      # Eject files in specified repo
  agency eject --silent          # Eject without output
  agency eject --help            # Show this help message

Notes:
  - Files are removed from git tracking but remain on disk
  - Entries are added to .gitignore automatically
`;
