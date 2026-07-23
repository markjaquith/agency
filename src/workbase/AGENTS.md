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
- `agency work` is the local launch flow and marks execution units `working`
  without claiming them. External orchestrators claim before launching runners.
- Do not manually create, move, or remove worktrees under `code/`.
- Use `agency archive`, rather than moving work item folders manually.
- Do not edit bare repositories or repository symlinks under `repos/`.
- Do not run `agency work` from an active agent session unless the user
  explicitly asks to launch another agent.
- Run `agency validate` before worktree or pull-request operations.
- Create a pull request only with explicit user intent, using
  `agency pr create <task> [phase]` so the URL is recorded durably.

## Closeout

An execution unit remains `working` after implementation is committed and while
its pull request is open. It becomes `done` only after its authoritative pull
request is merged and Agency reconciles that state. Do not mark committed or
review-ready work `done` manually.

At each closeout trigger (creating or updating a PR, marking it ready, completing
a refinement loop, or pausing or handing off completed implementation work):

- Finish an active claim with the current revision via `agency finish`; a
  successful claim outcome leaves unmerged work `working`. For unclaimed work,
  keep the execution unit `working` through review and merge.
- After merge, run `agency sync --apply` to reconcile the execution unit to
  `done`.
- Refresh durable delivery context in `TASK.md` or `PHASE.md`, including recorded
  PR state, current head, diff summary, and verification results after later
  pushes when those details are maintained there.
- Run `agency validate` before reporting completion.

## Managed Integration

`agency integration status` reports `managed`, `drifted`, `customized`, or
`missing` generated files. Agency keeps these instructions in
`.agency/AGENTS.md`, and its managed OpenCode config loads them automatically.
It also installs a managed server plugin that exposes skills from the
authoritative writable checkout and an explicitly registered TUI companion
providing `/agency-debug` without submitting an LLM prompt.
The workbase-root `AGENTS.md`, when present, belongs entirely to the workbase
owner and composes with these instructions through OpenCode's normal discovery.
`agency integration sync` updates only missing or checksum-safe drifted managed
files, removes checksum-valid retired artifacts, and preserves user-customized
files. `agency init` creates the managed files, and `agency work` reconciles them
before launching an agent.

OpenCode can access the complete workbase tree, but this filesystem permission
does not expand Agency write authority beyond the checkout reported by
`agency context`. OpenCode remains rooted in the task or epic directory so the
workbase instructions and config compose normally. The managed plugin resolves
the writable checkout from launch context or `agency context`, then adds its
supported skill directories through `skills.paths`; this does not make other
checkout-local OpenCode configuration authoritative. Agents must follow the
authority reported by `agency context`.
