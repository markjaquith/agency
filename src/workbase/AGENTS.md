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

If context or doctor reports a declared but missing repository, run
`agency repo setup --dry-run` and obtain explicit approval before
`agency repo setup --apply`. Missing declared aliases are setup state, not a
reason to edit `agency.json` or `repos/` by hand.

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

## Closeout

An execution unit is `working` while implementation or requested delivery work
remains. It becomes `done` when both are complete, even if its PR remains open
for review or merge. Do not leave a task or phase `working` solely because its PR
is open; if merge was requested, merge remains delivery work.

At each closeout trigger (creating or updating a PR, marking it ready, completing
a refinement loop, or pausing or handing off completed implementation work):

- Use `agency task status` or `agency phase status` to set the execution unit's
  current status. Finish an active claim with the current revision via
  `agency finish`.
- Refresh durable delivery context in `TASK.md` or `PHASE.md`, including recorded
  PR state, current head, diff summary, and verification results after later
  pushes when those details are maintained there.
- Run `agency validate` before reporting completion.

## Managed Integration

`agency integration status` reports `managed`, `drifted`, `customized`, or
`missing` generated files. `agency integration sync` updates only missing or
checksum-safe drifted files and preserves user-customized files. `agency init`
creates these files, and `agency work` reconciles them before launching an agent.

OpenCode can access the complete workbase tree, but this filesystem permission
does not expand Agency write authority beyond the checkout reported by
`agency context`.
