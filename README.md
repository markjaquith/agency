# @markjaquith/agency

Smuggle project-level LLM instruction into any Git repo. Plan your tasks. Commit your plans. Execute your plans using Opencode. Filter those plans out out your PRs.

## Installation

```bash
bun install -g @markjaquith/agency
```

## Primary Commands

### `agency task [branch-name]`

Initialize `AGENTS.md` and `TASK.md` files using the template you've set for this repo. Commits smuggled files and lands you on that branch.

### `agency task edit`

Open `TASK.md` in the system editor for editing. Nice if you have to paste in large amounts of context.

### `agency work`

Launch Opencode to work on the current task defined in `TASK.md`. All your context will be loaded.

### `agency emit [base-branch]`

Create an emit branch with smuggled files reverted to their merge-base state (removes additions/modifications to those files made on feature branch). Default branch name is current branch with `--PR` suffix.

### `agency push [base-branch]`

Runs `agency emit`, pushes the branch, and then switches back to the source branch.

**Options:**

- `--pr` - Open GitHub PR in browser after pushing (requires `gh` CLI)
- `--force` - Force push to remote if branch has diverged
- `--branch <name>` - Custom name for emit branch

### `agency merge`

Runs `agency emit`, and then merges the PR back into the base branch locally.

**Options:**

- `--squash` - Use squash merge instead of regular merge (stages changes, requires manual commit)
- `--push` - Push the base branch to origin after merging

## Other Commands

### `agency template use [template]`

Set which template to use for this repository. Shows interactive selection if no template name provided. Saves to `.git/config`.

### `agency template save <files...>`

Save the specified files back to the configured template directory (so they will be used for future `agency task` commands).

### `agency base get`

Get the base branch for the current feature branch.

### `agency base set <branch>`

Set the base branch for the current feature branch.

### `agency switch`

Toggle between source branch and emit branch. If on an emit branch (e.g., `foo--PR`), switches to source branch (e.g., `foo`). If on source branch and emit branch exists, switches to emit branch.

### `agency source`

Switch to the source branch for the current emit branch.

## Requirements

- [Bun](https://bun.sh) >= 1.0.0 (recommended)
- TypeScript ^5

## Development

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

### Git Hooks

This project uses [hk](https://github.com/jdx/hk) for git hook management. The configuration is in `hk.pkl`.

To install the git hooks:

```bash
hk install
```

**Pre-commit hook runs:**

- Prettier formatting
- Knip (unused code detection)
- TypeScript type checking

**Commit-msg hook validates:**

- Conventional commits format
- Commit message history

**Pre-push hook runs the same checks as pre-commit.**

Note: Tests are intentionally excluded from git hooks as they are slow. Run them manually with `bun test`.

## License

MIT
