---
name: agency
description: >
  Use Agency to manage filesystem-backed workbases, repository aliases, epics,
  tasks, phases, execution worktrees, and GitHub pull requests. Use when the
  user asks to create, inspect, validate, or work on Agency epics/tasks/phases;
  coordinate work across repositories; materialize task worktrees; or create a
  PR through Agency.
license: MIT
compatibility: Requires the agency CLI and Git, plus OpenCode or Claude Code. Interactive work selection uses fzf; PR creation uses gh.
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

Register known workbases so `agency work` can select one when run elsewhere:

```bash
agency workbase add <path>
agency workbase list
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

If phases are known up front, create a multi-phase task. To add a phase later,
use `--first-phase <id>` to name the phase created from the task's existing
execution fields and worktrees.

## Create Epics

```bash
agency epic create <id> \
  --ticket-url <url> \
  [--description <text>] \
  --repo <read-only-alias>:<ref> \
  [--repo <another-alias>:<ref>]
```

Epic task ordering and dependencies live in `EPIC.md`. Creating a task with
`--epic` automatically writes both sides of the epic/task relationship.

## Create Single-Phase Tasks

For guided creation, run `agency task new`. It prompts for text input, uses fzf
for known choices, and allows optional inputs to be skipped.

```bash
agency task create <id> \
  [--ticket-url <url>] \
  [--description <text>] \
  [--epic <epic-id>] \
  --repo <writable-alias> \
  [--reference <read-only-alias>:<ref>] \
  [--branch <branch>] \
  [--base <base>]
```

The branch defaults to `task/<id>` and the base defaults to `main`.

The task itself is the execution unit. Its worktrees live under
`tasks/{id}/code/{alias}`.

## Create Multi-Phase Tasks

Create the task container:

```bash
agency task create <id> \
  [--ticket-url <url>] \
  [--description <text>] \
  [--epic <epic-id>] \
  --multi-phase
```

Then create each phase:

```bash
agency phase create <task-id> <phase-id> \
  [--description <text>] \
  --repo <writable-alias> \
  [--reference <read-only-alias>:<ref>] \
  --branch <branch> \
  --base <base> \
  [--depends-on <phase-id>]
```

Repeat `--reference` and `--depends-on` when needed. Phase worktrees live under
`tasks/{task-id}/phases/{phase-id}/code/{alias}`.

Convert an existing single-phase task while adding another phase:

```bash
agency phase create <task-id> <new-phase-id> \
  --first-phase <existing-phase-id> \
  --repo <writable-alias> \
  --branch <new-branch> \
  --base <base> \
  [--depends-on <existing-phase-id>]
```

The conversion preserves task-level metadata and prose, moves execution metadata
into the named existing phase, and relocates any materialized worktrees.

## Frontmatter Rules

Agency documents use YAML 1.2 frontmatter:

```yaml
---
ticketUrl: https://example.com/tickets/example
description: Deliver the example outcome.
repo: application
repos:
  - repo: api
    ref: main
branch: task/example
base: main
pr: null
status: open
---
```

Follow these invariants:

- `ticketUrl` belongs to epics and tasks, not phases.
- `description` is an optional non-empty summary on epics, tasks, and phases.
- `repo` is the one writable repository for an execution unit.
- `repos` contains `{ repo, ref }` read-only references and must not repeat `repo`.
- Epics may declare `repos` but never `repo`.
- A writable `(repo, branch)` pair belongs to exactly one task or phase.
- Use a commit SHA for a read-only `ref` when reproducibility matters.

Commands that print Agency-owned results accept `--json` for machine-readable
output, including mutations, entity inspection, status, validation, and PR creation.

- Multi-phase task frontmatter owns the phase dependency graph.
- Epic frontmatter owns the child-task dependency graph.
- `pr` is either a GitHub PR URL string or `null`.
- Execution-unit `status` is `open`, `working`, `delegated`, `done`, or `dropped`.
  New work starts open, and `agency work` marks it working before agent launch.
- Keep directory IDs stable; encode sequencing with `dependsOn`, not numeric
  directory prefixes.
- Do not use YAML duplicate keys, anchors, aliases, or custom tags.

Prefer Agency commands for creation. When manually editing dependencies or
prose, preserve backlinks and run validation immediately afterward.

Update execution status with:

```bash
agency task status <task-id> <open|working|delegated|done|dropped>
agency phase status <task-id> <phase-id> <open|working|delegated|done|dropped>
```

## Archive Completed Work

```bash
agency archive epic <epic-id>
agency archive task <task-id>
agency archive phase <task-id> <phase-id>
```

Use these commands instead of moving work item folders manually. Agency mirrors
their hierarchy under `archive/`, removes registered worktrees first, and keeps
branches. It refuses dirty worktrees and active sibling dependencies.

## Validate Every Structural Change

```bash
agency validate [path]
```

Use `--json` when diagnostics will be consumed programmatically. Resolve all
validation errors before materializing worktrees or creating PRs. Validation
checks schemas, aliases, backlinks, phase directories, duplicate references,
duplicate writable branch ownership, unknown dependencies, and dependency cycles.
Outside a workbase, omitting path opens the registered-workbase picker.

## Worktrees And Agent Launch

```bash
agency work
agency work <task-id> [phase-id]
agency work --epic <epic-id>
```

Use `--opencode` or `--claude` to require a specific agent. This command fetches
repositories for execution targets, creates or reuses their worktrees, and
replaces the current process with the selected agent. It infers the nearest
epic, task, or phase from the current directory; otherwise it opens an `fzf`
picker containing the workbase hierarchy.
Outside a workbase, it first opens a picker containing registered workbases.

Epic and multi-phase task targets are orchestration sessions launched beside
their documents. Single-phase tasks and phases are execution sessions launched
in their writable checkout.

The workbase may delegate writable checkout creation through
`worktreeCreateCommand` in `agency.json`. Do not bypass that command or create a
parallel worktree manually. Supplemental read-only checkouts are still detached
Git worktrees managed directly by Agency at their declared refs.

Agency inspects `git worktree list --porcelain` before materializing. It reuses a
writable checkout only when both path and branch match, and reuses a reference
checkout only when its commit matches the declared ref. If a branch is checked
out elsewhere, choose a different branch or remove the conflicting worktree;
never force a second checkout of the branch.

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
