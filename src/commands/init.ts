import { resolve } from "path";

export interface InitOptions {
  path?: string;
}

export async function init(options: InitOptions = {}): Promise<void> {
  const targetPath = options.path ? resolve(options.path) : process.cwd();
  
  // Create AGENTS.md file
  const agentsPath = resolve(targetPath, "AGENTS.md");
  const claudePath = resolve(targetPath, "CLAUDE.md");
  
  try {
    // Create blank AGENTS.md
    await Bun.write(agentsPath, "");
    console.log(`Created ${agentsPath}`);
    
    // Create CLAUDE.md with @AGENTS.md content
    await Bun.write(claudePath, "@AGENTS.md");
    console.log(`Created ${claudePath}`);
    
    console.log("\nInitialization complete!");
  } catch (error) {
    console.error("Error during initialization:", error);
    throw error;
  }
}

export const help = `
Usage: agency init [path] [options]

Initialize AGENTS.md and CLAUDE.md files in a directory.

Arguments:
  path              Target directory (defaults to current directory)

Options:
  -h, --help        Show this help message

Examples:
  agency init                    # Initialize in current directory
  agency init ./my-project       # Initialize in specified directory
  agency init --help             # Show this help message
`;
