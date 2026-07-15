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

The workbase `agency.json` currently contains only `{ "version": 2 }`.
Repository metadata comes directly from Git under `repos/{alias}`.

## Frontmatter

### Epic

```yaml
---
ticketUrl: https://example.com/tickets/checkout
repos:
  - frontend
  - backend
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
epic: checkout
repo: frontend
repos:
  - backend
branch: task/refresh-copy
base: main
pr: null
---
```

### Multi-Phase Task

```yaml
---
ticketUrl: https://example.com/tickets/build-checkout
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
repo: frontend
repos:
  - backend
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
  --repo frontend \
  --reference backend \
  --branch task/refresh-copy \
  --base main

agency validate
agency work refresh-copy
agency pr create refresh-copy
```

## Commands

### Workbase and Repositories

```text
agency init [path]
agency repo add <alias> <remote>
agency repo link <alias> <path>
agency repo list [--json]
```

`repo add` creates a bare clone. `repo link` creates a symlink to an existing Git
repository. Alias names are then used by all documents and commands.

### Epics

```text
agency epic create <id> --ticket-url <url> --repo <alias> [--repo <alias>...]
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
  [--epic <id>] [--reference <alias>...]
```

Create a multi-phase task container:

```text
agency task create <id> --ticket-url <url> --multi-phase [--epic <id>]
```

Inspect tasks:

```text
agency task list [--json]
agency task show <id> [--json]
```

Adding a phase to an existing single-phase task is intentionally not automated.
Create the task with `--multi-phase` when phases are known in advance.

### Phases

```text
agency phase create <task-id> <phase-id>
  --repo <alias> --branch <name> --base <name>
  [--reference <alias>...] [--depends-on <phase-id>...]

agency phase list <task-id> [--json]
agency phase show <task-id> <phase-id> [--json]
```

### Work and Pull Requests

```text
agency work <task-id> [phase-id] [--opencode | --claude]
agency pr create <task-id> [phase-id] [--draft]
```

`agency work` fetches repositories, creates or reuses worktrees under `code/`,
and launches an agent in the writable checkout with absolute task and phase
context paths.

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
