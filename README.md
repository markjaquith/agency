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

### `agency pr [base-branch]`

Create a PR branch with smuggled files reverted to their merge-base state (removes additions/modifications to those files made on feature branch). Default branch name is current branch with `--PR` suffix.

### `agency push`

Runs `agency pr`, pushes the branch, and then switches back to the source branch.

### `agency merge`

Runs `agency pr`, and then merges the PR back into the base branch locally.

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

Toggle between source branch and PR branch. If on a PR branch (e.g., `foo--PR`), switches to source branch (e.g., `foo`). If on source branch and PR branch exists, switches to PR branch.

### `agency source`

Switch to the source branch for the current PR branch.

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

## License

MIT
