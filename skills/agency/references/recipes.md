# Agency Recipes

For an entity target, run `agency context . --json` before selecting a recipe.
At the workbase root, use `agency next --json` or `agency graph --json` to choose
a target, then inspect it with explicit `--epic`, `--task`, and `--phase`
selectors or its returned document path. Graph node keys such as `task/<id>` and
`phase/<task>/<phase>` are not positional context targets.

The machine-orchestration forms in the inspect-through-recover recipes are
captured in `fixtures/protocol/orchestration-recipes.json` and tested against the
real CLI parser. Their lifecycle behavior is covered by CLI and service fixtures.
Replace angle-bracket placeholders with values from context or a prior machine
result; never scrape them from human output.

## Initialize A Workbase

For an existing local checkout, initialize the workbase and link the repository:

```bash
agency init <workbase-path>
agency --workbase <workbase-path> repo link <alias> <repository-path>
agency validate <workbase-path>
agency --workbase <workbase-path> repo verify <alias>
```

Use `repo add <alias> <remote>` instead when Agency should create and manage a
bare clone from a remote. Initialization and repository registration require
explicit user intent.

## Restore A Workbase On A New Machine

After cloning the tracked workbase, inspect repository setup before applying it:

```bash
agency repo setup --dry-run --json
agency repo setup --apply --json
agency validate
agency doctor --json
```

Apply clones only declared missing repositories. It does not overwrite linked
checkouts, repair invalid paths, or choose between drifted remotes. Resolve those
states explicitly, then rerun setup. A machine may replace an unused managed
clone with `repo link`; the portable declaration remains available to every
other machine.

## Inspect A Target

```bash
agency context --task <task-id> --phase <phase-id> --json
agency worktree inspect <task-id> <phase-id> --json
```

Confirm the target, current document revision, readiness, authority, checkout,
claim, PR, and validation state. Use `--compact` only when prose and detailed Git
evidence are not needed.

## Find Ready Work

Run this from the intended workbase:

```bash
agency next --json
agency graph --ready --json
```

`next` ranks ready execution units and explains every excluded unit. It does not
reserve work. Another orchestrator may claim the same candidate before you do,
so always handle `CLAIM_CONFLICT` or `REVISION_CONFLICT`.

## Human: Create And Launch Work

```bash
agency task create refresh-copy --repo frontend --branch task/refresh-copy --base main
agency validate
agency work tasks/refresh-copy
```

For a multi-PR outcome:

```bash
agency task create checkout --multi-phase
agency phase create checkout api --repo backend --branch task/checkout-api --base main
agency phase create checkout ui --repo frontend --branch task/checkout-ui \
  --base main --reference backend:main --depends-on api
agency validate
agency work tasks/checkout/phases/api
```

`agency work` is intentionally last: it synchronizes managed integration files,
checks readiness, materializes worktrees, marks this execution unit working
without a claim, and launches the runner. Run it again to relaunch unclaimed
working work.

## Active Agent: Execute Assigned Work

```bash
agency context . --json
```

1. Verify context reports the expected execution target, valid structure, and
   the current checkout as `authority.writable.checkoutPath`. Reject dependency
   or validation blockers and conflicting active claims.
2. Read `TASK.md`, and `PHASE.md` for phase work.
3. Implement only in the writable checkout; treat all reference checkouts as
   read-only.
4. Run repository formatting, checks, build, and focused tests.
5. Review and commit the diff.
6. If requested, run `agency validate`, then
   `agency pr create <task-id> [phase-id]`.
7. Finish an active claim after its completion condition is true; otherwise set
   the task or phase status directly.

Never invoke `agency work` merely because an execution checkout already exists;
that would start another agent rather than continue the current assignment.

## Claim Ready Work

Get the current document revision from context. Use stable claimant, runner, and
session IDs:

```bash
agency claim checkout ui \
  --claimant orchestrator-1 --runner opencode --session-id session-123 \
  --revision <sha256> --json
```

Claim records ownership and sets status to `working`; it does not launch a runner
or recheck dependency readiness. A machine orchestrator must launch and monitor
its runner separately. There is no atomic find-and-claim or `assign` command.

## Prepare Checkouts

Preview and then materialize without claiming, launching, or changing status:

```bash
agency work prepare --task checkout --phase ui --dry-run --json
agency work prepare --task checkout --phase ui --json
```

Use the returned checkout paths and resolved commits. Do not create or move
worktrees manually.

## Assign A Runner

For a human-operated local launch, Agency combines readiness checks, prepare,
status mutation, and runner launch without creating a claim:

```bash
agency work tasks/checkout/phases/ui --runner opencode
```

This is not a JSON assignment API. An external orchestrator instead claims with
its own `claimant`, `runner`, and `session-id`, starts the runner outside Agency,
and passes it the target and claim result. Agency has no queue, heartbeat,
monitoring, cancellation, or automatic claim-renewal service.

## Reconcile Durable And Local State

```bash
agency sync --dry-run --json
agency sync --apply --json
```

The first command is observational. Apply may materialize an unconflicted missing
checkout, release an expired claim, record one unambiguous matching PR, or mark
unclaimed work done after its authoritative PR merges. Review `warnings` and
`unresolved`; apply never discards or resets work and never chooses among
ambiguous PRs.

## Release Interrupted Work

After every claim mutation, use the returned revision or inspect again. Release
interrupted work back to open:

```bash
agency release checkout ui --session-id session-123 \
  --revision <current-sha256> --json
```

## Finish Verified Work

Only after the assigned completion condition is true:

```bash
agency finish checkout ui --session-id session-123 \
  --revision <current-sha256> --outcome done --json
```

Do not substitute `phase status done` for `finish` when an active claim exists;
`finish` preserves ownership history and revision safety.

## Create A Pull Request

```bash
agency validate
agency pr create checkout ui --json
```

Agency materializes a missing workspace, then requires the writable worktree to
be clean. It pushes the declared branch, invokes the configured delivery
provider's create command or falls back to `gh pr create --fill`, and records the
returned pull request record. Do not manually write a URL or record if creation
fails. A PR being open is not equivalent to completion when the assigned outcome
requires merge.

Agency does not create commits, run tests, wait for checks, merge the PR, or
verify completion. Those remain orchestrator responsibilities.

## Convert A Task To Phases

Name the phase that inherits the existing task's execution metadata:

```bash
agency phase create refresh-copy verification \
  --first-phase implementation \
  --repo frontend --branch task/refresh-copy-verification --base main \
  --depends-on implementation
agency validate
```

Agency converts the task shape, creates both phase documents, and relocates
materialized worktrees. Do not perform those moves manually.

## Recover From Interrupted State

Inspect before applying changes:

```bash
agency doctor --json
agency sync --dry-run --json
agency worktree inspect <task-id> [phase-id] --json
agency worktree repair <task-id> [phase-id] --dry-run --json
```

Use `agency sync --apply` only with explicit user intent. It may safely
materialize an unconflicted missing checkout, release an expired claim, record a
single matching PR, or mark work done after its authoritative PR merged and no
claim remains. It never modifies dirty checkouts, switches branches, resets
references, chooses among PRs, or bypasses active claims.

For a worktree-specific issue, use `worktree repair --dry-run` before repair.
Repair is conservative and never discards work. Use remove or rebuild only after
reviewing the dry run and confirming every checkout is clean.

## Archive Or Restore

```bash
agency archive phase checkout ui --dry-run --json
agency archive phase checkout ui
agency restore phase checkout ui --dry-run --json
agency restore phase checkout ui
```

As an operating policy, archive only terminal work and only with explicit intent;
the CLI also permits safe archival of nonterminal work. Agency preserves the
branch and lifecycle provenance while enforcing graph, worktree, and destination
safety. Never move archived directories by hand.
