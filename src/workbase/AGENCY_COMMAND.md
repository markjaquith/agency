---
description: Operate Agency work with safe start, status, next, validate, and finish workflows
---

Operate the current Agency workbase using the managed Agency instructions.

Invocation inputs:

- Workflow: `$1`
- Optional target: `$2`
- Complete request: `$ARGUMENTS`

Use `status` when the workflow is empty. Treat words after the optional target as
additional user instructions. If the workflow is unknown, make no changes and
list the supported workflows.

Always follow these rules:

- Run `agency context . --json` first when no target is provided. With a target,
  pass that target to `agency context` instead.
- Use the returned document paths, readiness, authority, checkout state, claim,
  and validation result. Do not infer them from directory names.
- Stop on validation errors, dependency blockers, an unexpected writable
  repository, or a conflicting active claim.
- Write code only in `authority.writable.checkoutPath`; references are read-only.
- Never run `agency work` to start the current agent again.
- Create a pull request only when the complete request explicitly asks for one.

Dispatch the workflow as follows:

- `start`: Read the returned task and phase documents, inspect the writable
  checkout, then begin or resume the requested work in this session. Keep durable
  decisions current and carry the work through focused verification.
- `status`: Make no changes. Summarize the target, readiness, authority, durable
  status, claim and PR state, checkout state, current Git changes, blockers, and
  the most useful next action.
- `next`: Run `agency next --json`, summarize ready and blocked execution units,
  and recommend the highest-priority ready unit. Do not launch another agent.
- `validate`: Run Agency validation for the discovered workbase. Explain every
  issue and, when safe and within authority, repair requested non-structural
  problems before validating again.
- `finish`: Complete any remaining requested implementation first. Run focused
  repository checks, refresh the task or phase delivery context, and run
  `agency validate`. Finish an active claim with its current revision; otherwise
  update unclaimed status only when the requested outcome and delivery work are
  actually complete. Do not create a PR unless explicitly requested.
- `help`: Make no changes. Briefly explain these workflows and the positional
  form `/agency <workflow> [target] [additional instructions]`.
