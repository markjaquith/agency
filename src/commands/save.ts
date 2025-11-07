import { resolve, join } from "path";
import { isInsideGitRepo, getGitRoot, getGitConfig } from "../utils/git";
import { MANAGED_FILES } from "../types";
import { getTemplateDir } from "../utils/template";

export interface SaveOptions {
  silent?: boolean;
  verbose?: boolean;
}

export async function save(options: SaveOptions = {}): Promise<void> {
  const { silent = false, verbose = false } = options;
  const log = silent ? () => {} : console.log;
  const verboseLog = verbose && !silent ? console.log : () => {};
  
  // Check if in a git repository
  if (!(await isInsideGitRepo(process.cwd()))) {
    throw new Error("Not in a git repository. Please run this command inside a git repo.");
  }
  
  const gitRoot = await getGitRoot(process.cwd());
  if (!gitRoot) {
    throw new Error("Failed to determine the root of the git repository.");
  }
  
  // Get template name from git config
  const templateName = await getGitConfig("agency.template", gitRoot);
  if (!templateName) {
    throw new Error("No template configured for this repository. Run 'agency init' first.");
  }
  
  verboseLog(`Saving to template: ${templateName}`);
  
  const templateDir = getTemplateDir(templateName);
  
  try {
    // Save each managed file
    for (const managedFile of MANAGED_FILES) {
      const sourceFilePath = resolve(gitRoot, managedFile.name);
      const sourceFile = Bun.file(sourceFilePath);
      
      if (!(await sourceFile.exists())) {
        verboseLog(`Skipping ${managedFile.name} (does not exist)`);
        continue;
      }
      
      const content = await sourceFile.text();
      const templateFilePath = join(templateDir, managedFile.name);
      
      await Bun.write(templateFilePath, content);
      log(`✓ Saved ${managedFile.name} to '${templateName}' template`);
    }
  } catch (err) {
    // Re-throw errors for CLI handler to display
    throw err;
  }
}

export const help = `
Usage: agency save [options]

Save the current AGENTS.md and CLAUDE.md files to the configured template.

This command reads the managed files from the current git repository and saves
them to the template directory configured in .git/config (agency.template).

Options:
  -h, --help        Show this help message
  -s, --silent      Suppress output messages
  -v, --verbose     Show verbose output

Examples:
  agency save                    # Save files to configured template
  agency save --verbose          # Save with verbose output
  agency save --help             # Show this help message

Notes:
  - Requires agency.template to be set (run 'agency init' first)
  - Files are saved to ~/.config/agency/templates/{template-name}/
  - Existing template files will be overwritten
`;
