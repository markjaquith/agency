# @markjaquith/agency

A CLI tool for managing `AGENTS.md` files in your projects.

## Installation

```bash
bun add @markjaquith/agency
```

Or with npm:

```bash
npm install @markjaquith/agency
```

## Commands

### `agency init [path]`

Initialize `AGENTS.md` file using templates. On first run, prompts for a template name and saves it to `.git/config`. Subsequent runs use the saved template.

### `agency use [template]`

Set which template to use for this repository. Shows interactive selection if no template name provided. Saves to `.git/config`.

### `agency save [files...]`

Save current `AGENTS.md` file back to the configured template directory.

### `agency pr [base-branch]`

Create a PR branch with managed files reverted to their merge-base state (removes modifications made on feature branch). Default branch name is current branch with `--PR` suffix.

### `agency switch`

Toggle between source branch and PR branch. If on a PR branch (e.g., `main--PR`), switches to source branch (e.g., `main`). If on source branch, switches to PR branch. PR branch must exist first.

### `agency merge`

Merge the current PR branch into the configured base branch. If run from a source branch, automatically creates/updates the PR branch first, then merges it. If run from a PR branch, merges it directly into the base branch.

**Usage:**

- From source branch: `agency merge` (creates PR branch, then merges)
- From PR branch: `agency merge` (merges directly)

The command automatically:

1. Detects whether you're on a source or PR branch
2. Retrieves the configured base branch from git config
3. Switches to the base branch
4. Merges the PR branch into the base branch

This is useful for local development workflows where you want to test merging your clean PR branch (without `AGENTS.md` modifications) into the base branch before pushing.

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
