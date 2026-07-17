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

## Authority

- An epic or multi-phase task is orchestration context and has no implementation
  write authority.
- For an execution unit, write code only at
  `authority.writable.checkoutPath`. Every `authority.references` checkout is
  read-only, even if filesystem permissions allow writes.
- Keep task-wide decisions in `TASK.md` and phase-specific delivery context in
  `PHASE.md`. Use Agency commands for structural frontmatter mutations.

## Safety

- Stop on validation errors, dependency blockers, an unexpected writable
  repository, or a conflicting active claim.
- Do not begin execution without a claim. `agency work` claims before launch;
  external orchestrators use `agency claim` with the revision from context.
- Do not manually create, move, or remove worktrees under `code/`.
- Use `agency archive`, rather than moving work item folders manually.
- Do not edit bare repositories or repository symlinks under `repos/`.
- Do not run `agency work` from an active agent session unless the user
  explicitly asks to launch another agent.
- Run `agency validate` before worktree or pull-request operations.
- Create a pull request only with explicit user intent, using
  `agency pr create <task> [phase]` so the URL is recorded durably.
- Mark work done only when its completion condition is true. A created PR is not
  completion when merge is required. Finish an active claim with the current
  revision via `agency finish`; otherwise use the task or phase status command.

## Managed Integration

`agency integration status` reports `managed`, `drifted`, `customized`, or
`missing` generated files. `agency integration sync` updates only missing or
checksum-safe drifted files and preserves user-customized files.

OpenCode references expose only task and epic context and do not expand Agency
write authority. Reference directories receive OpenCode's scoped external-path
access automatically; other missing tool permissions remain visible rather than
being blanket-allowed.
