# Agency Workbase

This directory is an Agency workbase. Epics, tasks, and phases are durable
Markdown documents; repository aliases and generated Git worktrees provide code
access.

## Bootstrap

Start every session with one read-only command:

```bash
agency context . --json
```

Use the returned target, document paths and revisions, dependency readiness,
authority, checkout state, PR state, and validation result. Do not infer these
from directory names or stale prose.

At the workbase root, use `agency next --json` or `agency graph --json` to choose
work, then inspect the returned document path or explicit entity selectors. Use
`agency --help` and `agency <command> --help` for exact command syntax.

If context or doctor reports a declared but missing repository, run
`agency repo setup --dry-run` and obtain explicit approval before
`agency repo setup --apply`. Missing declared aliases are setup state, not a
reason to edit `agency.json` or `repos/` by hand.

## Authority

- An epic or multi-phase task is orchestration context and has no implementation
  write authority.
- A single-phase task or phase is an execution unit with one writable `repo` and
  optional read-only `repos`. Only `done` satisfies a dependency; `dropped` is
  terminal but leaves dependents blocked.
- For an execution unit, write code only at
  `authority.writable.checkoutPath`. Every `authority.references` checkout is
  read-only, even if filesystem permissions allow writes.
- Keep task-wide decisions in `TASK.md` and phase-specific delivery context in
  `PHASE.md`. Use Agency commands for structural frontmatter mutations.

## Consent Boundaries

Require explicit user intent before initializing a workbase; changing repository
aliases or applying repository setup or workbase sync changes; launching another
agent from an active agent session; creating a pull request; archiving, restoring,
dropping, or reopening work; or using `--force` to override readiness.

## Safety

- Stop on validation errors, dependency blockers, an unexpected writable
  repository, or a conflicting active claim.
- Do not manually create, move, or remove worktrees under `code/`.
- Use `agency archive`, rather than moving work item folders manually.
- Do not edit bare repositories or repository symlinks under `repos/`.
- Never invent entity IDs, revisions, PR state, dependency completion, or
  checkout state. Preserve parent backlinks and dependency declarations.
- Do not bypass dirty-worktree, active-claim, revision, or readiness protections.
- Do not run `agency work` from an active agent session unless the user
  explicitly asks to launch another agent.
- Run `agency validate` before worktree or pull-request operations.
- Create a pull request only with explicit user intent, using
  `agency pr create <task> [phase]` so the URL is recorded durably.

## Execution

For implementation work, read the task and phase prose returned by context,
change only the writable checkout, keep durable decisions current, and run the
repository's formatting, type checks, build, dead-code checks, and focused tests.
Review and commit the diff according to the repository's instructions.

`agency work` is the human launch flow: it reconciles managed integration,
selects work, checks readiness, prepares checkouts, marks execution work
`working` without creating a claim, and starts the runner. Epic and multi-phase
task launches remain orchestration-only. External orchestrators instead claim
an execution unit, launch and monitor their runner separately, and finish or
release the claim with the current document revision.

## Closeout

An execution unit is `working` while implementation or requested delivery work
remains. It becomes `done` when both are complete, even if its PR remains open
for review or merge. Do not leave a task or phase `working` solely because its PR
is open; if merge was requested, merge remains delivery work.

At each closeout trigger (creating or updating a PR, marking it ready, completing
a refinement loop, or pausing or handing off completed implementation work):

- Finish an active claim with the current revision via `agency finish`.
  Otherwise use `agency task status` or `agency phase status` to set the
  execution unit's current status.
- Refresh durable delivery context in `TASK.md` or `PHASE.md`, including recorded
  PR state, current head, diff summary, and verification results after later
  pushes when those details are maintained there.
- Run `agency validate` before reporting completion.

## Managed Integration

`agency integration status` reports `managed`, `drifted`, `customized`, or
`missing` generated files. Agency keeps these instructions in
`.agency/AGENTS.md`, and its managed OpenCode config loads them automatically.
The workbase-root `AGENTS.md`, when present, belongs entirely to the workbase
owner and composes with these instructions through OpenCode's normal discovery.
`agency integration sync` updates only missing or checksum-safe drifted managed
files and preserves user-customized files. `agency init` creates the managed
files, and `agency work` reconciles them before launching an agent.

OpenCode can access the complete workbase tree, but this filesystem permission
does not expand Agency write authority beyond the checkout reported by
`agency context`. OpenCode discovers the managed project config from task and
epic launch directories. No machine-specific path or runtime permission overlay
is required; agents must follow the authority reported by `agency context`.
