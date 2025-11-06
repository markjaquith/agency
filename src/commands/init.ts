import { resolve } from "path";
import { isInsideGitRepo, getGitRoot, isGitRoot } from "../utils/git";

export interface InitOptions {
  path?: string;
}

export async function init(options: InitOptions = {}): Promise<void> {
  let targetPath: string;
  
  if (options.path) {
    // If path is provided, validate it's a git repository root
    targetPath = resolve(options.path);
    
    if (!(await isGitRoot(targetPath))) {
      console.error("ⓘ Error: The specified path is not the root of a git repository.");
      console.error("   Please provide a path to the top-level directory of a git checkout.");
      throw new Error("Not a git repository root");
    }
  } else {
    // If no path provided, use git root of current directory
    if (!(await isInsideGitRepo(process.cwd()))) {
      console.error("ⓘ Not in a git repository. Please run this command inside a git repo.");
      throw new Error("Not in a git repository");
    }
    
    const gitRoot = await getGitRoot(process.cwd());
    if (!gitRoot) {
      console.error("ⓘ Failed to determine the root of the git repository.");
      throw new Error("Could not find git root");
    }
    
    targetPath = gitRoot;
  }
  
  // Create AGENTS.md file
  const agentsPath = resolve(targetPath, "AGENTS.md");
  const claudePath = resolve(targetPath, "CLAUDE.md");
  
  try {
    // Create blank AGENTS.md if it doesn't exist
    const agentsFile = Bun.file(agentsPath);
    if (!(await agentsFile.exists())) {
      await Bun.write(agentsPath, "");
      console.log(`Created ${agentsPath}`);
    } else {
      console.log(`ⓘ AGENTS.md already exists at ${agentsPath}`);
    }
    
    // Create CLAUDE.md with @AGENTS.md content if it doesn't exist
    const claudeFile = Bun.file(claudePath);
    if (!(await claudeFile.exists())) {
      await Bun.write(claudePath, "@AGENTS.md");
      console.log(`Created ${claudePath}`);
    } else {
      console.log(`ⓘ CLAUDE.md already exists at ${claudePath}`);
    }
    
    console.log("\nInitialization complete!");
  } catch (error) {
    console.error("Error during initialization:", error);
    throw error;
  }
}

export const help = `
Usage: agency init [path] [options]

Initialize AGENTS.md and CLAUDE.md files in a git repository.

When no path is provided, initializes files at the root of the current git
repository. When a path is provided, it must be the root directory of a git
repository.

Arguments:
  path              Path to git repository root (defaults to current repo root)

Options:
  -h, --help        Show this help message

Examples:
  agency init                    # Initialize in current git repo root
  agency init ./my-project       # Initialize in specified git repo root
  agency init --help             # Show this help message

Notes:
  - Files are created at the git repository root, not the current directory
  - If files already exist, they will not be overwritten
  - The specified path (if provided) must be a git repository root
`;
