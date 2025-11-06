#!/usr/bin/env bun

import { resolve } from "path";

const commands = {
  init: async (path?: string) => {
    const targetPath = path ? resolve(path) : process.cwd();
    
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
      process.exit(1);
    }
  },
};

// Parse command line arguments
const [, , command, ...args] = process.argv;

if (!command) {
  console.log("Usage: agency <command> [options]");
  console.log("\nCommands:");
  console.log("  init [path]    Initialize AGENTS.md and CLAUDE.md files");
  process.exit(1);
}

if (command === "init") {
  await commands.init(args[0]);
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
