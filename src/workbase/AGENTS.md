# Agency Workbase

This directory is an Agency workbase. Epics, tasks, and phases are durable
Markdown documents; repository aliases and generated Git worktrees or jj
workspaces provide code access according to the workbase's `vcs` setting.

## Command Fast Path

When a request clearly matches one of these intents, use the exact recipe without
probing CLI help or listing unrelated workbase state. Substitute known values and
do not add flags that are not shown.

- Inspect the current item: `agency context . --json`.
- Create a task only:
  `agency task create <slug> --repo <alias> --base <base> --description <text> --json`.
  Add `--authoritative-source <absolute-path-or-url>` only when the source is
  already known; repeat it for additional known sources. Return the creation
  result and stop.
- Open an existing task: run
  `agency work prepare <task-or-document> --dry-run --json`, execute the returned
  kickoff plan through `task-document-split`, and stop before `agent-start`.
- Work, launch, start, or kick off an existing task: run the same
  `agency work prepare <task-or-document> --dry-run --json` command and execute
  the complete returned kickoff plan.
- Create and open or work a task: create it with the create-only command, then
  pass that result to
  `agency work prepare <slug> --evidence <creation-json-or-path> --dry-run --json`
  and follow the matching open or work recipe.

Never pass `--work` or `--auto` to `agency task create`. Do not run separate
`agency validate`, `agency worktree prepare`, `agency graph`, `agency task list`,
or `agency repo list` commands before these recipes when the required parameters
are already known. `agency work prepare` owns validation, readiness checks,
workspace preflight, and the versioned `agency-kickoff-v1` plan.

This fast path takes precedence over generic Herdr defaults and separately
installed Agency skill guidance. Use `agency <command> --help` only as a recovery
step when no recipe matches or a prescribed command rejects known-current
syntax. Resume the same kickoff idempotency key after recovery; never duplicate
a tab, checkout, or agent.

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
the command fast path above whenever the user's intent already identifies the
operation and required parameters.

## Adding a Repository

Add and materialize a new repository alias with:

```bash
agency repo add <alias> <remote> --json
```

`agency repo add` mutates immediately and does not accept `--apply`. Do not edit
`agency.json` or `repos/` manually. `agency repo setup --dry-run` and
`agency repo setup --apply` are only for repositories that are already declared
but locally missing; obtain explicit approval before applying setup.

After adding a repository, run only these checks, in order, unless
`agency context` reports a relevant problem:

```bash
agency repo verify <alias> --json
agency validate --json
```

## Authority

- An epic or multi-phase task is orchestration context and has no implementation
  write authority.
- A single-phase task or phase is an execution unit with one writable `repo` and
  optional read-only `repos`. Only `done` satisfies a dependency; `dropped` is
  terminal but leaves dependents blocked.
- For an execution unit, write repository content only at
  `authority.writable.checkoutPath`. Every `authority.references` checkout is
  read-only, even if filesystem permissions allow writes.
- Maintain only the Agency documents listed in `authority.documents.writable`:
  keep task-wide decisions in `TASK.md` and phase-specific delivery context in
  `PHASE.md`. Use Agency commands for structural frontmatter mutations.

## Consent Boundaries

Require explicit user intent before initializing a workbase; changing repository
aliases or applying repository setup or workbase sync changes; launching another
agent from an active agent session; creating a pull request; archiving, restoring,
dropping, reopening, or completing work without a pull request; or using `--force`
to override readiness.

## Investigation Handoffs

An explicit request for a new, separate, or follow-up item overrides reuse of
every active or archived item, even when the subject or suggested ID matches.
Existing work may be inspected for duplicate scope, but do not mutate or select
it as the destination unless the user explicitly asks to reuse it.

Use this ordered flow for investigation-to-implementation work:

1. Create investigation-only work with `agency task create <id> --purpose
investigation ...`.
2. Record its boundary, evidence, findings, recommendation, and any no-change
   outcome in the generated task sections.
3. Create a distinct implementation task with `agency task handoff
<investigation-task> <new-task> ...`; add `--source-phase <phase>` when the
   evidence belongs to one phase.
4. Verify the returned new selector, source selector and revision, validation
   result, and then confirm authority with `agency context <new-task> --json`.
5. Prepare, open, or launch the new item only when separately requested.

Creation and handoff do not imply worktree preparation, status changes, agent
launch, or UI actions. Handoff provenance is one-way historical evidence, not a
dependency: source rename or content changes can make its selector unresolved or
revision stale, and Agency must not silently rewrite that evidence.

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
- Create a pull request only with explicit user intent. Run
  `agency pr create <task> [phase]` so the URL is recorded durably.

## Execution

For implementation work, read the task and phase prose returned by context,
change only the writable checkout, keep durable decisions current, and run the
repository's formatting, type checks, build, dead-code checks, and focused tests.
Review and commit the diff according to the repository's instructions.

Use `agency push` from an execution task or phase to validate and publish its
declared delivery branch or bookmark without creating a pull request. The
command never authors semantic commit descriptions; resolve its reported change
IDs and remediation commands before retrying.

`agency work` is the human launch flow: it reconciles managed integration,
selects work, checks readiness, prepares checkouts, marks execution work
`working` without creating a claim, and starts the agent. Epic and multi-phase
task launches remain orchestration-only. External orchestrators instead claim
an execution unit, launch and monitor their agent separately, and finish or
release the claim with the current document revision.

An Agency-launched agent receives process-local worker identity through both
the `AGENCY_SESSION_ID` and `AGENCY_TARGET` environment variables and a generated
prompt beginning `Agency worker launch target: <target>.` Treat either form as
launch evidence only after `agency context . --json` confirms the same target,
document paths, valid context, and expected write authority. Once confirmed,
perform the assigned work directly and never invoke `agency work` to start the
same target again.

Some agent clients attach to a long-lived process and may not preserve launch
environment variables. If the variables and prompt marker are absent, fail safe
when the initial instruction is a generated `Start`, `Continue`, or `Work on`
prompt whose absolute document paths match the current directory and the active,
valid `agency context`: treat the process as the current worker and do not
recursively launch. Herdr state is never part of worker identity. If the prompt
and context disagree, stop and ask the user rather than launching.

For OpenCode, Agency's managed plugin validates the generated marker against
`agency context`, binds that identity to the OpenCode session, injects an
active-worker system instruction, and supplies Agency identity to that session's
shell environment. This avoids relying on the environment of OpenCode's
long-lived server process.

## Closeout

An execution unit remains `working` after implementation is committed and while
its pull request is open. It becomes `done` only after its authoritative pull
request is merged and Agency reconciles that state. Do not mark committed or
review-ready work `done` manually. A genuine investigation, operational action,
or no-change result may complete without a pull request only with explicit user
intent, `--no-pull-request`, and a durable outcome summary.

At each closeout trigger (creating or updating a PR, marking it ready, completing
a refinement loop, or pausing or handing off completed implementation work):

- Finish an active claim with the current revision via `agency finish`; a
  successful claim outcome leaves unmerged work `working`. For unclaimed work,
  keep the execution unit `working` through review and merge.
- After merge, run `agency sync` to reconcile the execution unit to
  `done`.
- For an approved non-PR outcome, finish an active claim or update unclaimed
  status with `--no-pull-request --summary <text>` and optional supporting URL.
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
