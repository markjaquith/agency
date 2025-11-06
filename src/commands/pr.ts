export interface PrOptions {
  branch?: string;
}

export async function pr(_options: PrOptions = {}): Promise<void> {
  // TODO: Implement PR command
  console.log("PR command not yet implemented");
  throw new Error("Not implemented");
}

export const help = `
Usage: agency pr [branch] [options]

Create a PR branch based on the current branch without AGENTS.md/CLAUDE.md.

Arguments:
  branch            Target branch name (defaults to current branch + '--PR')

Options:
  -h, --help        Show this help message

Examples:
  agency pr                      # Create PR branch with default name
  agency pr feature-pr           # Create PR branch with custom name
  agency pr --help               # Show this help message
`;
