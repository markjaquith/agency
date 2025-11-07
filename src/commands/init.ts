import { resolve, join } from "path";
import { isInsideGitRepo, getGitRoot, isGitRoot } from "../utils/git";
import { getConfigDir } from "../config";
import { MANAGED_FILES } from "../types";

export interface InitOptions {
  path?: string;
  silent?: boolean;
  verbose?: boolean;
}

export async function init(options: InitOptions = {}): Promise<void> {
  const { silent = false, verbose = false } = options;
  const log = silent ? () => {} : console.log;
  const verboseLog = verbose && !silent ? console.log : () => {};
  
  let targetPath: string;
  
  if (options.path) {
    // If path is provided, validate it's a git repository root
    targetPath = resolve(options.path);
    
    if (!(await isGitRoot(targetPath))) {
      throw new Error("The specified path is not the root of a git repository. Please provide a path to the top-level directory of a git checkout.");
    }
  } else {
    // If no path provided, use git root of current directory
    if (!(await isInsideGitRepo(process.cwd()))) {
      throw new Error("Not in a git repository. Please run this command inside a git repo.");
    }
    
    const gitRoot = await getGitRoot(process.cwd());
    if (!gitRoot) {
      throw new Error("Failed to determine the root of the git repository.");
    }
    
    targetPath = gitRoot;
  }
  
  const configDir = getConfigDir();
  
  try {
    // Process each managed file
    for (const managedFile of MANAGED_FILES) {
      const targetFilePath = resolve(targetPath, managedFile.name);
      const targetFile = Bun.file(targetFilePath);
      
      if (await targetFile.exists()) {
        log(`ⓘ ${managedFile.name} already exists at ${targetFilePath}`);
        continue;
      }
      
      // Check if source file exists in config directory
      const sourceFilePath = join(configDir, managedFile.name);
      const sourceFile = Bun.file(sourceFilePath);
      
      let content: string;
      if (await sourceFile.exists()) {
        // Use source file from config directory
        content = await sourceFile.text();
        verboseLog(`Using source file from ${sourceFilePath}`);
      } else {
        // Use default content
        content = managedFile.defaultContent ?? "";
        verboseLog(`Using default content for ${managedFile.name}`);
      }
      
      await Bun.write(targetFilePath, content);
      log(`Created ${targetFilePath}`);
    }
  } catch (err) {
    // Re-throw errors for CLI handler to display
    throw err;
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
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output

Examples:
  agency init                    # Initialize in current git repo root
  agency init ./my-project       # Initialize in specified git repo root
  agency init --silent           # Initialize without output
  agency init --verbose          # Initialize with verbose output
  agency init --help             # Show this help message

Notes:
  - Files are created at the git repository root, not the current directory
  - If files already exist, they will not be overwritten
  - The specified path (if provided) must be a git repository root
`;
