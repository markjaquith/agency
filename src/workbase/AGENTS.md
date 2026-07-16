# Agency Workbase

This directory is an Agency workbase. Epics, tasks, and phases are durable
Markdown documents; repository aliases and generated Git worktrees provide code
access.

## Session Context

Before doing work, identify the current entity from the working directory and
read its context:

- In `epics/<epic>/`, read `EPIC.md`. Coordinate the epic's tasks without
  writing implementation code.
- In `tasks/<task>/`, read `TASK.md`. A task with `phases` is an orchestration
  session; a task without `phases` is a single execution unit.
- In `tasks/<task>/phases/<phase>/`, read both `../../TASK.md` and `PHASE.md`.
  The phase is the execution unit.

For execution units, writable and reference checkouts live under `code/` when
materialized. Write only through the checkout named by the singular `repo`
field. Repositories listed in plural `repos` are read-only references.

## Safety

- Keep task-level decisions in `TASK.md` and phase-specific delivery context in
  `PHASE.md`.
- Do not manually create, move, or remove worktrees under `code/`.
- Do not edit bare repositories or repository symlinks under `repos/`.
- Do not run `agency work` from an active agent session unless the user
  explicitly asks to launch another agent.
- Run `agency validate` before worktree or pull-request operations.
- Create a pull request only when the user explicitly requests it.
