# Agency

Agency is a CLI tool for managing `AGENTS.md`, `TASK.md`, and `opencode.json` files in git repositories. It helps coordinate work across multiple branches and templates.

## Key Commands

- `agency init` - Initialize template files on a feature branch
- `agency save` - Save current file versions back to a template
- `agency use` - Switch to a different template
- `agency pr` - Create a PR branch with managed files reverted to their merge-base state
- `agency switch` - Toggle between feature and PR branches
- `agency source` - Get the path to a template's source directory
- `agency set-base` - Update the saved base branch for PR creation

## Features

- **Template-based workflow** - Reusable templates stored in `~/.config/agency/templates/`
- **Git integration** - Saves template configuration in `.git/config`
- **PR branch management** - Automatically creates clean PR branches without local modifications
- **Multi-file support** - Manages AGENTS.md, TASK.md, and opencode.json
