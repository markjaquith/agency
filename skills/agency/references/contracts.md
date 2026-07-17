# Agency Data Contracts

Use Agency JSON output instead of scraping human tables. Entity IDs are directory
names; they are not duplicated in frontmatter.

## Context Contract

`agency context . --json` returns a versioned success envelope whose result
contains:

- `projection`: `complete` or explicitly requested `compact`;
- `workbase`: root, config path, and config version;
- `target`: resolved epic, task, or phase identity;
- `documents`: ancestor frontmatter, paths, SHA-256 revisions, and prose;
- `graph`: parent, dependencies, dependents, readiness blockers, and progress;
- `authority`: `orchestration` or `execution`, one writable checkout or none,
  and read-only references;
- `workspace`: code path, materialization and registration state, commits, and
  inspection warnings;
- `pr`: recorded URL and state; and
- `validation`: validity and issues.

Compact context retains identity, revisions, authority, paths, graph state,
materialization, and warnings while omitting prose and low-level Git details.

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
must be non-empty when present. `pr` is a GitHub PR URL or `null`. Status is
`open`, `working`, `delegated`, `done`, or `dropped`; `delegated` is readable
legacy state but cannot be newly assigned.

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

Success:

```json
{ "version": 1, "ok": true, "result": {} }
```

Failure:

```json
{
	"version": 1,
	"ok": false,
	"error": {
		"code": "VALIDATION_FAILED",
		"message": "Workbase validation failed.",
		"fields": {},
		"retryable": false,
		"remediation": "Resolve the reported validation issues."
	}
}
```

`--json` writes exactly one envelope to stdout; diagnostics stay on stderr.
Branch on stable `error.code`, inspect structured `fields`, and retry only when
`retryable` and the operation is safe. Published schemas are
`schemas/agency-envelope-v1.schema.json` and
`schemas/agency-graph-v1.schema.json`.
