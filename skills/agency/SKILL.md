---
name: agency
description: >
  Use Agency to manage filesystem-backed workbases, repository aliases, epics,
  tasks, phases, execution worktrees, and GitHub pull requests. Use when the
  user asks to create, inspect, validate, or work on Agency epics/tasks/phases;
  coordinate work across repositories; materialize task worktrees; or create a
  PR through Agency.
license: MIT
compatibility: Requires the agency CLI, Git, and optionally gh plus OpenCode or Claude Code.
---

# Agency

Use Agency to coordinate durable work across one or more Git repositories.
Agency stores planning and orchestration as Markdown with YAML frontmatter while
keeping repository checkouts as local workbase state.

## Mental Model

- A **workbase** is the root containing `agency.json`, `repos/`, `epics/`, and
  `tasks/`.
- A repository alias is a bare Git repository or symlink at `repos/{alias}`.
- An **epic** orchestrates tasks and only reads repositories.
- A **task** describes one durable outcome. It may be standalone or belong to an
  epic.
- A **phase** belongs to a multi-phase task and corresponds to one PR or intended
  PR.
- An **execution unit** is either a single-phase task or a phase. It has one
  writable `repo`, optional read-only `repos`, one branch, one base, and one
  `pr` value.

IDs are directory names. Do not repeat IDs in document frontmatter.

## Start By Inspecting

From anywhere beneath a workbase, run:

```bash
agency status --json
agency validate --json
agency repo list --json
agency epic list --json
agency task list --json
```

Use `show` before changing an existing entity:

```bash
agency epic show <epic-id> --json
agency task show <task-id> --json
agency phase show <task-id> <phase-id> --json
```

If no workbase is found, do not initialize one without user intent. When asked:

```bash
agency init [path]
```

## Repository Aliases

Add a remote as an Agency-managed bare repository:

```bash
agency repo add <alias> <git-remote>
```

Link an existing local Git repository:

```bash
agency repo link <alias> <path>
```

Use aliases, never absolute paths or Git URLs, in epic/task/phase frontmatter.

## Choose The Correct Work Shape

Use a single-phase task when one PR in one writable repository can deliver the
outcome. Use a multi-phase task when the outcome requires multiple intended PRs,
possibly across repositories or with sequencing dependencies. Use an epic when
several independently meaningful tasks need orchestration.

Do not add a phase to a single-phase task: automatic conversion is not
supported. If phases are known up front, create a multi-phase task.

## Create Epics

```bash
agency epic create <id> \
  --ticket-url <url> \
  [--description <text>] \
  --repo <read-only-alias> \
  [--repo <another-alias>]
```

Epic task ordering and dependencies live in `EPIC.md`. Creating a task with
`--epic` automatically writes both sides of the epic/task relationship.

## Create Single-Phase Tasks

```bash
agency task create <id> \
  --ticket-url <url> \
  [--description <text>] \
  [--epic <epic-id>] \
  --repo <writable-alias> \
  [--reference <read-only-alias>] \
  --branch <branch> \
  --base <base>
```

The task itself is the execution unit. Its worktrees live under
`tasks/{id}/code/{alias}`.

## Create Multi-Phase Tasks

Create the task container:

```bash
agency task create <id> \
  --ticket-url <url> \
  [--description <text>] \
  [--epic <epic-id>] \
  --multi-phase
```

Then create each phase:

```bash
agency phase create <task-id> <phase-id> \
  [--description <text>] \
  --repo <writable-alias> \
  [--reference <read-only-alias>] \
  --branch <branch> \
  --base <base> \
  [--depends-on <phase-id>]
```

Repeat `--reference` and `--depends-on` when needed. Phase worktrees live under
`tasks/{task-id}/phases/{phase-id}/code/{alias}`.

## Frontmatter Rules

Agency documents use YAML 1.2 frontmatter:

```yaml
---
ticketUrl: https://example.com/tickets/example
description: Deliver the example outcome.
repo: application
repos:
  - api
branch: task/example
base: main
pr: null
---
```

Follow these invariants:

- `ticketUrl` belongs to epics and tasks, not phases.
- `description` is an optional non-empty summary on epics, tasks, and phases.
- `repo` is the one writable repository for an execution unit.
- `repos` contains only read-only references and must not repeat `repo`.
- Epics may declare `repos` but never `repo`.

Commands that print Agency-owned results accept `--json` for machine-readable
output, including mutations, entity inspection, status, validation, and PR creation.

- Multi-phase task frontmatter owns the phase dependency graph.
- Epic frontmatter owns the child-task dependency graph.
- `pr` is either a GitHub PR URL string or `null`.
- Keep directory IDs stable; encode sequencing with `dependsOn`, not numeric
  directory prefixes.
- Do not use YAML duplicate keys, anchors, aliases, or custom tags.

Prefer Agency commands for creation. When manually editing dependencies or
prose, preserve backlinks and run validation immediately afterward.

## Validate Every Structural Change

```bash
agency validate
```

Use `--json` when diagnostics will be consumed programmatically. Resolve all
validation errors before materializing worktrees or creating PRs. Validation
checks schemas, aliases, backlinks, phase directories, duplicate references,
unknown dependencies, and dependency cycles.

## Worktrees And Agent Launch

```bash
agency work <task-id> [phase-id]
```

Use `--opencode` or `--claude` to require a specific agent. This command fetches
repositories, creates or reuses the execution worktrees, changes into the
writable checkout, and replaces the current process with the selected agent.

The workbase may delegate writable checkout creation through
`worktreeCreateCommand` in `agency.json`. Do not bypass that command or create a
parallel worktree manually. Supplemental read-only checkouts are still detached
Git worktrees managed directly by Agency.

Do not run `agency work` from inside an active agent session unless the user
explicitly wants to launch a nested/replacement agent process. If already
working in an Agency checkout, read the owning `TASK.md` and optional `PHASE.md`
directly instead.

## Create Pull Requests

Only create a PR when the user explicitly requests it:

```bash
agency pr create <task-id> [phase-id] [--draft]
```

Agency requires a clean writable worktree, pushes the execution branch, runs
`gh pr create --fill`, and records the returned URL in the owning document's
`pr` field. If PR creation fails, do not invent or manually write a URL.

## Safety Rules

- Run `agency validate` before worktree or PR operations.
- Inspect existing entities before editing them.
- Never write through a repository listed in plural `repos`.
- Do not manually move generated `code/` worktrees.
- Do not manually edit bare repositories under `repos/`.
- Do not create a PR, initialize a workbase, clone a remote, or add a symlink
  without user intent.
- Keep task-level decisions in `TASK.md` and delivery-specific context in
  `PHASE.md`.
