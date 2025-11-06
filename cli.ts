#!/usr/bin/env bun

import { parseArgs } from "util";
import { init, help as initHelp } from "./src/commands/init";
import { eject, help as ejectHelp } from "./src/commands/eject";
import { pr, help as prHelp } from "./src/commands/pr";
import type { Command } from "./src/types";

// Read version from package.json
const packageJson = await Bun.file(new URL("./package.json", import.meta.url)).json();
const VERSION = packageJson.version;

// Define commands
const commands: Record<string, Command> = {
  init: {
    name: "init",
    description: "Initialize AGENTS.md and CLAUDE.md files",
    run: async (args: string[], options: Record<string, any>) => {
      if (options.help) {
        console.log(initHelp);
        return;
      }
      await init({ path: args[0], silent: options.silent });
    },
    help: initHelp,
  },
  eject: {
    name: "eject",
    description: "Remove AGENTS.md and CLAUDE.md from git tracking",
    run: async (args: string[], options: Record<string, any>) => {
      if (options.help) {
        console.log(ejectHelp);
        return;
      }
      await eject({ path: args[0], silent: options.silent });
    },
    help: ejectHelp,
  },
  pr: {
    name: "pr",
    description: "Create a PR branch without AGENTS.md/CLAUDE.md",
    run: async (args: string[], options: Record<string, any>) => {
      if (options.help) {
        console.log(prHelp);
        return;
      }
      await pr({ branch: args[0], silent: options.silent });
    },
    help: prHelp,
  },
};

function showMainHelp() {
  console.log(`
agency v${VERSION}

Usage: agency <command> [options]

Commands:
  init [path]       Initialize AGENTS.md and CLAUDE.md files
  eject [path]      Remove AGENTS.md and CLAUDE.md from git tracking
  pr [branch]       Create a PR branch without AGENTS.md/CLAUDE.md

Global Options:
  -h, --help        Show help for a command
  -v, --version     Show version number

Examples:
  agency init                    # Initialize in current directory
  agency eject                   # Remove files from git tracking
  agency init --help             # Show help for init command
  agency --version               # Show version number

For more information about a command, run:
  agency <command> --help
`);
}

// Parse global arguments
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: {
        type: "boolean",
        short: "h",
      },
      version: {
        type: "boolean",
        short: "v",
      },
    },
    strict: false,
    allowPositionals: true,
  });

  // Handle global flags
  if (values.version) {
    console.log(`v${VERSION}`);
    process.exit(0);
  }

  // Get command
  const commandName = positionals[0];

  // Show help if no command
  if (!commandName) {
    showMainHelp();
    process.exit(1);
  }

  // Show main help if --help with no command
  if (values.help && !commandName) {
    showMainHelp();
    process.exit(0);
  }

  // Check if command exists
  const command = commands[commandName];
  if (!command) {
    console.error(`Error: Unknown command '${commandName}'`);
    console.error("\nRun 'agency --help' for usage information.");
    process.exit(1);
  }

  // Parse command-specific arguments
  const commandArgs = process.argv.slice(3);
  const { values: cmdValues, positionals: cmdPositionals } = parseArgs({
    args: commandArgs,
    options: {
      help: {
        type: "boolean",
        short: "h",
      },
      silent: {
        type: "boolean",
        short: "s",
      },
    },
    strict: false,
    allowPositionals: true,
  });

  // Run the command
  await command.run(cmdPositionals, cmdValues);
} catch (error) {
  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error("An unexpected error occurred:", error);
  }
  process.exit(1);
}
