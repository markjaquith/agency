# Agency Data Contracts

Use Agency JSON output instead of scraping human tables. Entity IDs are directory
names; they are not duplicated in frontmatter.

## Context Contract

`agency context . --json` returns a versioned success envelope whose result
contains:

- `projection`: `compact` for root discovery by default, otherwise `complete`
  unless compact entity context was explicitly requested;
- `workbase`: root, config path, and config version;
- `target`: resolved workbase, epic, task, or phase identity;
- `discovery`: at the workbase root, all valid epic, task, and phase documents;
- `documents`: ancestor frontmatter, paths, SHA-256 revisions, and prose;
- `graph`: parent, dependencies, dependents, readiness blockers, and progress;
- `authority`: `orchestration` or `execution`, one writable checkout or none,
  and read-only references;
- `workspace`: code path, materialization and registration state, commits, and
  inspection warnings;
- `pr`: recorded provider-neutral pull request identity and state; and
- `validation`: validity and issues.

Compact context retains identity, revisions, authority, paths, graph state,
materialization, and warnings while omitting prose and low-level Git details.

## Repository Declarations

Tracked `agency.json` may contain portable repository declarations:

```json
{
	"version": 2,
	"repositories": {
		"frontend": { "remote": "git@example.com:team/frontend.git" }
	}
}
```

Remotes are provider-neutral network Git remotes. Local paths, file URLs, and
credential-bearing HTTP URLs are invalid. `repos/`, task and phase `code/`, and
symlink targets are local-only and never part of this contract.

Repository inspection returns `declaredRemote`, the actual local `remote`, and
orthogonal `states`: `declared`, `materialized`, `linked`, `missing`, `invalid`,
and `remote-drifted`. Setup JSON contains `mode`, `actions`, `unresolved`, and the
post-operation `repositories`. Actions are `materialize` or `adopt`, with
`planned` or `applied` status. Dry-run never mutates. Apply never overwrites a
link or path and never repairs drift without an explicit remote choice.

## Frontmatter Shapes

### Epic

```yaml
---
ticketUrl: https://example.com/tickets/checkout
description: Coordinate checkout delivery.
repos:
  - repo: frontend
    ref: main
tasks:
  - id: api
  - id: ui
    dependsOn:
      - api
---
```

Epics have read-only `repos`, never a writable `repo`. Their `tasks` list owns
task ordering and task dependencies.

### Single-Phase Task

```yaml
---
ticketUrl: null
description: Refresh checkout copy.
epic: checkout
repo: frontend
repos:
  - repo: backend
    ref: main
branch: task/refresh-copy
base: main
pr: null
status: open
---
```

### Multi-Phase Task

```yaml
---
ticketUrl: null
description: Deliver checkout.
epic: checkout
phases:
  - id: api
  - id: ui
    dependsOn:
      - api
---
```

The task's `phases` list owns phase ordering and dependencies. Execution fields
belong in each phase document.

### Phase

```yaml
---
description: Build the checkout UI.
repo: frontend
repos:
  - repo: backend
    ref: main
branch: task/checkout-ui
base: task/checkout-api
pr: null
status: open
---
```

`ticketUrl` belongs to tasks and epics, not phases. `description` is optional but
must be non-empty when present. `pr` is `null`, a legacy GitHub PR URL, or a
provider-neutral record containing `provider`, `repository`, `identifier`, `url`,
`state`, `draft`, `merged`, and optional `mergeable`. Mergeability is `true`,
`false`, or `null` when the provider cannot determine it. New PR creation writes
the structured record.
Status is `open`, `working`, `delegated`, `done`, or `dropped`; `delegated` is
readable legacy state but cannot be newly assigned.

## Structural Invariants

- An execution unit has one writable `repo`; plural `repos` are read-only
  `{ repo, ref }` entries and cannot repeat the writable alias.
- A writable `(repo, branch)` pair belongs to exactly one active execution unit.
- Only `done` satisfies dependencies. `dropped` is terminal but blocks dependents.
- Epic task dependencies live in `EPIC.md`; phase dependencies live in `TASK.md`.
- IDs remain stable; use `dependsOn`, not numeric directory prefixes, for order.
- YAML duplicate keys, anchors, aliases, and custom tags are invalid.
- Use a commit SHA as a reference `ref` when reproducibility is required.

## Graph Contract

`agency graph --json` emits graph contract version 1. Stable node IDs are
`epic:<id>`, `task:<id>`, `phase:<task>/<phase>`,
`repository:<alias>`, and `execution-unit:<kind>/<id>`. Edge types are `owns`,
`depends_on`, `writes`, and `references`.

Every work node includes status, readiness, `blockedBy`, detailed blockers,
terminal state, reverse dependents, and aggregate progress. Filters run after
state computation. `--jsonl` emits a versioned `meta` record, node and edge
records, then an `end` record; together they reconstruct the JSON result.

## Machine Envelope

The published success fixture is normalized from
`agency init /work/agency --json`:

```json
{
	"version": 1,
	"ok": true,
	"result": {
		"root": "/work/agency"
	}
}
```

The published error fixture is the output of `agency unknown --json`:

```json
{
	"version": 1,
	"ok": false,
	"error": {
		"code": "CLI_USAGE",
		"message": "Unknown command 'unknown'.\n\nUsage: agency <command> [options]",
		"fields": {
			"detail": "Unknown command 'unknown'.",
			"usage": "agency <command> [options]"
		},
		"retryable": false,
		"remediation": "Correct the arguments using the usage value in error.fields."
	}
}
```

These examples are exported from `fixtures/protocol/` and tested against real
CLI subprocess output. The Effect schemas are exported by the package and by
`@markjaquith/agency/protocol`. The distributable JSON Schemas are exported as
`@markjaquith/agency/schemas/agency-envelope-v1.json` and
`@markjaquith/agency/schemas/agency-graph-v1.json`.

Only the envelope and graph result have published JSON Schemas. The envelope's
`result` is intentionally unconstrained. Context, next, claim, prepare, sync,
repository setup, and PR result shapes are exercised by CLI tests but do not have independent
published schemas.

### Output And Exit Guarantees

- `--json` writes exactly one newline-terminated envelope to stdout on success
  or failure. It disables interactive selection and takes precedence over
  `--silent`; explicit entity selectors remain valid.
- Human output is not a machine contract. Do not parse tables, progress text, or
  diagnostic wording.
- Progress and verbose diagnostics use stderr. Structured command warnings stay
  inside the stdout result. Successful JSON mode does not promise empty stderr
  when `--verbose` is requested.
- Success, help, and version output exit `0`. Usage errors and every command
  failure exit `1`. Version 1 has no error-specific exit statuses; branch on
  `error.code`.
- `graph --jsonl` is the one streaming exception. On success it writes a `meta`
  record, node and edge records, and an `end` record rather than an envelope. A
  JSONL failure still writes one error envelope and exits `1`.
- A command that emits zero machine results succeeds with `result: null`.
  Multiple results are a `PROTOCOL_OUTPUT_ERROR`.

### Error Codes

| Code                      | Meaning                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `CLI_USAGE`               | Invalid command, option, argument, or combination              |
| `WORKBASE_NOT_FOUND`      | No workbase could be resolved                                  |
| `WORKBASE_CONFIG_INVALID` | Invalid workbase configuration                                 |
| `WORKBASE_REGISTRY_ERROR` | Invalid or inaccessible workbase registry                      |
| `FILE_NOT_FOUND`          | A required path does not exist                                 |
| `FILESYSTEM_ERROR`        | A filesystem operation failed                                  |
| `FRONTMATTER_INVALID`     | Durable document frontmatter is invalid                        |
| `VALIDATION_FAILED`       | Workbase validation reported issues                            |
| `REPOSITORY_ERROR`        | Repository operation failed                                    |
| `EPIC_ERROR`              | Epic operation failed                                          |
| `TASK_ERROR`              | Task operation failed                                          |
| `PHASE_ERROR`             | Phase operation failed                                         |
| `CLAIM_ERROR`             | Claim input or lifecycle state is invalid                      |
| `CLAIM_CONFLICT`          | Active or legacy ownership conflicts with an operation         |
| `REVISION_CONFLICT`       | A durable document changed since inspection                    |
| `CLAIM_OWNERSHIP`         | The session does not own the active claim                      |
| `ARCHIVE_ERROR`           | Archive or restore operation failed                            |
| `WORKTREE_ERROR`          | Worktree operation failed                                      |
| `PULL_REQUEST_ERROR`      | Pull request operation failed                                  |
| `CONTEXT_ERROR`           | A context target or required document is invalid               |
| `GRAPH_ERROR`             | Graph construction or filtering failed                         |
| `EXECUTION_BLOCKED`       | Readiness or lifecycle blockers prevent execution              |
| `SYNC_ERROR`              | Reconciliation validation, inspection, or provider data failed |
| `PROCESS_ERROR`           | A child process failed                                         |
| `PROTOCOL_OUTPUT_ERROR`   | A command violated the one-result machine contract             |
| `COMMAND_FAILED`          | An otherwise unclassified failure                              |

`CLAIM_CONFLICT`, `REVISION_CONFLICT`, and `PROCESS_ERROR` are retryable in the
v1 metadata. Retryable means new evidence may change the result, not that blind
or non-idempotent retries are safe. Inspect `fields` and apply `remediation`
before retrying.

## Revisions And Concurrency

A document revision is the lowercase SHA-256 hash of the complete Markdown file,
including frontmatter and prose. It is per document, not a workbase-wide graph
revision. Context, graph, and entity reads expose revisions.

`claim`, `release`, and `finish` require `--revision <sha256>`. They lock and
recheck the execution document before an atomic replacement, then return
`previousRevision` and the new `revision`. Use the returned revision or inspect
again before the next mutation. Claim conflicts include the current revision and
ownership evidence in `error.fields`; revision conflicts include ownership only
when claim evidence applies.

Structural update, rename, move, and dependency commands accept optional
`--if-revision <sha256>`. Machine orchestrators should provide it. Multi-document
mutations recheck every affected file while holding the graph mutation lock.

## Selectors And Projections

`--workbase <id|name|path>` selects a registered workbase by ID, name, or path;
an existing path may also resolve an unregistered workbase directly. `--cwd
<path>` asks Agency to perform target inference as if invoked there. They are
mutually exclusive. Targeted commands accept `--epic`, `--task`, and `--phase`
where applicable; phase requires task, and entity selectors cannot be combined
with a positional target ID. Non-target positional values, such as a status
outcome, remain valid where the command syntax requires them.

`--json`, `--no-input`, and non-TTY execution disable interactive prompts and
selection. Supply every required value or explicit entity selector. Global
`--cwd` and `--workbase` selectors apply to `next` as they do to other discovery
commands.

At a workbase root, context defaults to a compact discovery catalog of epics,
tasks, and phases, includes no writable authority, and provides a hint for
requesting `--full`. Entity context defaults to the `complete` projection.
`--compact` omits prose and low-level Git details but retains identity, document
hashes, authority, paths, graph state, materialization, and validation warnings.

Graph projections are opt-in with repeatable
`--include <bodies|workspace|git|pr>`. Filters such as `--ready`, `--blocked`,
`--status`, `--repository`, and `--kind` are applied after readiness and graph
state are computed; returned edges always have both endpoints in the filtered
node set.

## Capability Boundaries

- There is no atomic find-ready-and-claim operation. `next` is observational,
  and `claim` does not enforce dependency readiness. Inspect readiness, then
  claim with the observed revision and handle conflicts.
- There is no `assign` command, remote queue, scheduler, heartbeat, claim renewal,
  runner monitor, or cancellation API. `work` launches one local built-in or
  configured runner without a claim; it is a process-launching, non-JSON flow
  rather than a machine assignment API. External orchestrators claim with
  claimant and runner IDs, then manage their runner themselves.
- Agency does not edit code, create commits, run repository checks, wait for PR
  checks, merge PRs, or verify that a requested completion condition is true.
  `finish` records the caller's asserted outcome after ownership checks.
- Reconciliation never discards changes, switches branches, resets reference
  commits, moves conflicting worktrees, chooses among multiple PRs, or bypasses
  active claims. Such conditions remain unresolved for a human or orchestrator.
- `delegated` is readable legacy state but cannot be newly assigned. `--force`
  only overrides readiness for `work` and `pr create`; it is not general
  reconciliation authority.
