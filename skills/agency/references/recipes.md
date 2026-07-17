# Agency Recipes

Run `agency context . --json` before selecting a recipe.

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

`agency work` is intentionally last: it checks readiness, materializes
worktrees, creates a claim, marks the execution unit working, and launches the
runner.

## Active Agent: Execute Assigned Work

```bash
agency context . --json
```

1. Verify context reports the expected execution target, no blockers, valid
   structure, and the current checkout as `authority.writable.checkoutPath`.
2. Read `TASK.md`, and `PHASE.md` for phase work.
3. Implement only in the writable checkout; treat all reference checkouts as
   read-only.
4. Run repository formatting, checks, build, and focused tests.
5. Review and commit the diff.
6. If requested, run `agency validate`, then
   `agency pr create <task-id> [phase-id]`.
7. Finish the current claim only after its completion condition is true.

Never invoke `agency work` merely because an execution checkout already exists;
that would start another agent rather than continue the current assignment.

## Claim, Release, And Finish

Get the current document revision from context. Use stable claimant, runner, and
session IDs:

```bash
agency claim checkout ui \
  --claimant orchestrator-1 --runner opencode --session-id session-123 \
  --revision <sha256>
```

After every claim mutation, inspect context again before using another revision.
Release interrupted work back to open:

```bash
agency release checkout ui --session-id session-123 --revision <current-sha256>
```

Finish verified work:

```bash
agency finish checkout ui --session-id session-123 \
  --revision <current-sha256> --outcome done
```

Do not substitute `phase status done` for `finish` when an active claim exists;
`finish` preserves ownership history and revision safety.

## Create A Pull Request

```bash
agency validate
agency pr create checkout ui
```

The writable worktree must be clean. Agency pushes the declared branch, uses
`gh pr create --fill`, and records the returned URL. Do not manually write a URL
if creation fails. A PR being open is not equivalent to completion when the
assigned outcome requires merge.

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

## Recover Or Reconcile

Inspect before applying changes:

```bash
agency doctor --json
agency sync --dry-run --json
agency worktree inspect <task-id> [phase-id] --json
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

Archive only terminal work and only with explicit intent. Agency preserves the
branch and lifecycle provenance while enforcing graph, worktree, and destination
safety. Never move archived directories by hand.
