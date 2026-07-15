# @markjaquith/agency

Agency manages durable agentic work across repositories. Epics, tasks, and
phases live as Markdown documents in a filesystem-backed workbase. Repository
aliases and Git worktrees provide each execution unit with the code it may read
or write.

## Requirements

- [Bun](https://bun.sh) 1.0 or newer
- Git
- [GitHub CLI](https://cli.github.com/) for `agency pr create`
- OpenCode or Claude Code for `agency work`

## Installation

```bash
bun install -g @markjaquith/agency
```

For development, run `bun link` from this repository.

## Core Model

- A **workbase** is the root containing durable documents and local repository
  state.
- An **epic** orchestrates tasks, may inspect repositories, and never writes
  code.
- A **task** describes one durable outcome and may stand alone or belong to an
  epic.
- A **phase** belongs to a multi-phase task and represents one PR or intended
  PR.
- An **execution unit** is either a single-phase task or a phase. It has exactly
  one writable `repo`, optional read-only `repos`, a branch, a base, and a
  `string | null` PR URL.

Entity IDs come from directory names. Structured metadata lives in YAML 1.2
frontmatter; prose below it supplies human and agent context.

## Workbase Layout

```text
workbase/
  agency.json
  repos/
    frontend/              # bare Git repository or symlink
    backend/
  epics/
    checkout/
      EPIC.md
  tasks/
    refresh-copy/          # single-phase task
      TASK.md
      code/                # created by agency work
        frontend/
    build-checkout/        # multi-phase task
      TASK.md
      phases/
        backend-api/
          PHASE.md
          code/
            backend/
        frontend-ui/
          PHASE.md
          code/
            frontend/
            backend/
```

Repository metadata comes directly from Git under `repos/{alias}`. Workbase
configuration may provide a custom writable-worktree creation command.

### Custom Worktree Command

By default, Agency creates worktrees with Git. Set `worktreeCreateCommand` to an
argv template when another tool should create writable worktrees:

```json
{
	"version": 2,
	"worktreeCreateCommand": [
		"my-worktree-tool",
		"--repo",
		"{repo}",
		"--destination",
		"{worktree}",
		"--branch",
		"{branch}"
	]
}
```

Available placeholders are:

- `{repo}`: absolute repository alias path under `repos/`
- `{worktree}`: absolute checkout path Agency requires
- `{branch}`: execution branch the custom command must create or check out
- `{base}`: configured execution base

`{repo}` and `{worktree}` are required. Agency invokes the command directly
without a shell, sets matching `AGENCY_REPO`, `AGENCY_WORKTREE`,
`AGENCY_BRANCH`, and `AGENCY_BASE` environment variables, and verifies that the
requested destination exists afterward.

Worktrunk can be configured per workbase without changing the user's Worktrunk
path settings:

```json
{
	"version": 2,
	"worktreeCreateCommand": [
		"wt",
		"-C",
		"{repo}",
		"-y",
		"--config-set",
		"worktree-path=\"{worktree}\"",
		"switch",
		"--create",
		"--base",
		"{base}",
		"{branch}",
		"--no-cd",
		"--format",
		"json"
	]
}
```

Custom commands own writable branch creation. Agency checks for conflicting
worktrees first, invokes the command only when the branch is not checked out,
and verifies that `{worktree}` exists afterward.

The configured command applies only to the writable checkout. Supplemental
read-only repositories remain detached Git worktrees at their declared refs so
they do not acquire writable branches.

## Frontmatter

### Epic

```yaml
---
ticketUrl: https://example.com/tickets/checkout
description: Coordinate the checkout experience across frontend and backend.
repos:
  - repo: frontend
    ref: main
  - repo: backend
    ref: main
tasks:
  - id: backend-api
  - id: frontend-ui
    dependsOn:
      - backend-api
---
```

### Single-Phase Task

```yaml
---
ticketUrl: https://example.com/tickets/refresh-copy
description: Refresh user-facing checkout copy.
epic: checkout
repo: frontend
repos:
  - repo: backend
    ref: main
branch: task/refresh-copy
base: main
pr: null
---
```

### Multi-Phase Task

```yaml
---
ticketUrl: https://example.com/tickets/build-checkout
description: Deliver checkout through sequenced backend and frontend changes.
epic: checkout
phases:
  - id: backend-api
  - id: frontend-ui
    dependsOn:
      - backend-api
---
```

Each listed phase has a `phases/{id}/PHASE.md` containing its execution fields:

```yaml
---
description: Build the checkout interface against the new backend API.
repo: frontend
repos:
  - repo: backend
    ref: main
branch: task/checkout-ui
base: task/checkout-api
pr: null
---
```

Epic task dependencies belong in `EPIC.md`. Phase dependencies belong in the
owning `TASK.md`. Stable IDs do not encode ordering in directory names.

## Quick Start

```bash
agency init ~/work
cd ~/work

agency repo add frontend git@github.com:example/frontend.git
agency repo link backend ~/Dev/backend

agency task create refresh-copy \
  --ticket-url https://example.com/tickets/refresh-copy \
  --description "Refresh user-facing checkout copy" \
  --repo frontend \
  --reference backend:main \
  --branch task/refresh-copy \
  --base main

agency validate
agency work refresh-copy
agency pr create refresh-copy
```

## Commands

### Workbase and Repositories

```text
agency init [path] [--json]
agency repo add <alias> <remote> [--json]
agency repo link <alias> <path> [--json]
agency repo list [--json]
```

`repo add` creates a bare clone. `repo link` creates a symlink to an existing Git
repository. Alias names are then used by all documents and commands.

Commands that print Agency-owned results accept `--json`, including initialization,
repository mutations, entity creation/list/show, status, validation, and PR creation.

### Epics

```text
agency epic create <id> --ticket-url <url> [--description <text>] [--json]
  --repo <alias>:<ref> [--repo <alias>:<ref>...]
agency epic list [--json]
agency epic show <id> [--json]
```

Creating a task with `--epic <id>` adds the task to the epic and writes the task
back-reference.

### Tasks

Create a single-phase task:

```text
agency task create <id> --ticket-url <url> --repo <alias>
  --branch <name> --base <name>
  [--description <text>] [--epic <id>] [--reference <alias>:<ref>...] [--json]
```

Create a multi-phase task container:

```text
agency task create <id> --ticket-url <url> --multi-phase
  [--description <text>] [--epic <id>] [--json]
```

Inspect tasks:

```text
agency task list [--json]
agency task show <id> [--json]
```

To add a phase to an existing single-phase task, name the phase that will own
the task's current execution fields with `--first-phase`:

```text
agency phase create refresh-copy verification
  --first-phase implementation
  --repo frontend --branch task/refresh-copy-verification --base main
  --depends-on implementation
```

Agency converts `TASK.md` to the multi-phase shape, creates both phase documents,
and moves existing worktrees from the task's `code/` directory into the first
phase. Dependencies remain explicit through `--depends-on`.

### Phases

```text
agency phase create <task-id> <phase-id>
  --repo <alias> --branch <name> --base <name>
  [--description <text>] [--reference <alias>:<ref>...]
  [--depends-on <phase-id>...] [--first-phase <phase-id>] [--json]

agency phase list <task-id> [--json]
agency phase show <task-id> <phase-id> [--json]
```

### Work and Pull Requests

```text
agency work <task-id> [phase-id] [--opencode | --claude]
agency pr create <task-id> [phase-id] [--draft] [--json]
```

`agency work` fetches repositories, creates or reuses worktrees under `code/`,
and launches an agent in the writable checkout with absolute task and phase
context paths.

Each writable `(repo, branch)` pair may belong to only one task or phase. Agency
validation reports duplicate ownership, and `agency work` checks Git's worktree
registry before creating or reusing a checkout. It reuses only an exact
path/branch match; if the branch is checked out elsewhere or the target path has
the wrong branch, the command fails with the conflicting path instead of forcing
another checkout.

Read-only references use `<alias>:<ref>` on the CLI and `{ repo, ref }` in YAML.
Agency resolves the ref to a commit and creates a detached worktree. Existing
reference worktrees are reused only while their commit still matches the declared
ref; use a commit SHA as `ref` when reproducibility matters.

`agency pr create` requires a clean writable worktree. It pushes the branch,
runs `gh pr create --fill`, and writes the returned GitHub PR URL into `pr` in
the owning `TASK.md` or `PHASE.md`.

### Status and Validation

```text
agency status [--json]
agency validate [--json]
```

Validation checks JSON and YAML parsing, Effect Schema conformance, repository
aliases, parent/child backlinks, phase directories, duplicate references,
unknown dependencies, and dependency cycles. YAML duplicate keys, anchors,
aliases, and custom tags are rejected.

## Agent Skill

`skills/agency/SKILL.md` contains an agent-oriented operating guide for Agency.
Install or link that directory into your agent's skill location when you want
Agency workflows to be discovered automatically.

## Development

```bash
bun install
bun link
bun run build
```

Run focused tests with `bun test <test-file>`. Run formatting with `bun format`.

## License

MIT
