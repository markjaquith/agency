# @markjaquith/agency

Agency manages durable agentic work across repositories. Epics, tasks, and
phases live as Markdown documents in a filesystem-backed workbase. Repository
aliases and Git worktrees provide each execution unit with the code it may read
or write.

## Requirements

- [Bun](https://bun.sh) 1.0 or newer
- Git
- [GitHub CLI](https://cli.github.com/) for `agency pr create`
- OpenCode, Claude Code, or a configured runner for `agency work`

## Installation

```bash
bun install -g @markjaquith/agency
```

For development, run `bun link` from this repository.

## Core Model

- A **workbase** is the root containing durable documents and local repository
  state.
- An **epic** orchestrates tasks, may inspect repositories, and never writes
  code.
- A **task** describes one durable outcome and may stand alone or belong to an
  epic.
- A **phase** belongs to a multi-phase task and represents one PR or intended
  PR.
- An **execution unit** is either a single-phase task or a phase. It has exactly
  one writable `repo`, optional read-only `repos`, a branch, a base, and a
  `string | null` PR URL.

Entity IDs come from directory names. Structured metadata lives in YAML 1.2
frontmatter; prose below it supplies human and agent context.

New epic, task, and phase documents use the same core prose sections:
`Outcome` states the intended result, `Plan` describes the current approach, and
`Important Decisions` preserves consequential choices and their rationale. These
sections are creation defaults rather than validation requirements, so existing
and customized documents remain valid.

## Workbase Layout

```text
workbase/
  AGENTS.md                # managed workbase instructions
  .opencode/
    opencode.jsonc         # managed task and epic references
  agency.json              # tracked config and portable repository declarations
  repos/                   # ignored local materializations
    frontend/              # bare Git repository or symlink
    backend/
  epics/
    checkout/
      EPIC.md
  tasks/
    refresh-copy/          # single-phase task
      TASK.md
      code/                # created by agency work
        frontend/
    build-checkout/        # multi-phase task
      TASK.md
      phases/
        backend-api/
          PHASE.md
          code/
            backend/
        frontend-ui/
          PHASE.md
          code/
            frontend/
            backend/
```

Agency keeps discovery and other observational commands read-only. Run
`agency integration status` to inspect `AGENTS.md` and
`.opencode/opencode.jsonc`, then `agency integration sync` to create missing
files or refresh checksum-safe managed files. Customized files are reported but
never overwritten.

The OpenCode config advertises only the task and epic directories as documented
references. OpenCode automatically grants those references scoped
external-directory access, so Agency does not add blanket permission rules that
could hide missing tool permissions. References provide context and never expand
the write authority reported by `agency context`.

Repository aliases and canonical fetch remotes are declared in tracked
`agency.json`; local bare clones and symlinks remain ignored under
`repos/{alias}`. A declaration contains no local path, symlink target, checkout,
or credential:

```json
{
	"version": 2,
	"repositories": {
		"frontend": {
			"remote": "git@example.com:team/frontend.git"
		}
	}
}
```

Existing version 2 workbases without `repositories` remain valid. Run
`agency repo setup` to preview deterministic adoption of legacy local aliases;
`agency repo setup --apply` writes declarations only when a portable origin is
unambiguous. Workbase configuration may also provide a custom writable-worktree
creation command.

### Custom Worktree Command

By default, Agency creates worktrees with Git. Set `worktreeCreateCommand` to an
argv template when another tool should create writable worktrees:

```json
{
	"version": 2,
	"worktreeCreateCommand": [
		"my-worktree-tool",
		"--repo",
		"{repo}",
		"--destination",
		"{worktree}",
		"--branch",
		"{branch}"
	]
}
```

Available placeholders are:

- `{repo}`: absolute repository alias path under `repos/`
- `{worktree}`: absolute checkout path Agency requires
- `{branch}`: execution branch the custom command must create or check out
- `{base}`: configured execution base

`{repo}` and `{worktree}` are required. Agency invokes the command directly
without a shell, sets matching `AGENCY_REPO`, `AGENCY_WORKTREE`,
`AGENCY_BRANCH`, and `AGENCY_BASE` environment variables, and verifies that the
requested destination exists afterward.

Worktrunk can be configured per workbase without changing the user's Worktrunk
path settings:

```json
{
	"version": 2,
	"worktreeCreateCommand": [
		"wt",
		"-C",
		"{repo}",
		"-y",
		"--config-set",
		"worktree-path=\"{worktree}\"",
		"switch",
		"--create",
		"--base",
		"{base}",
		"{branch}",
		"--no-cd",
		"--format",
		"json"
	]
}
```

Custom commands own writable branch creation. Agency checks for conflicting
worktrees first, invokes the command only when the branch is not checked out,
and verifies that `{worktree}` exists afterward.

The configured command applies only to the writable checkout. Supplemental
read-only repositories remain detached Git worktrees at their declared refs so
they do not acquire writable branches.

### Agent Runners

OpenCode and Claude Code are built-in runner presets. Select either preset or a
configured runner with `agency work --runner <name>`. A launch is fresh unless
`AGENCY_SESSION_ID` is already set; resumed launches use the runner's
`resumeCommand` when configured. The built-in presets use `--continue` only for
resumed launches.

Custom runners are direct argv commands, never shell snippets:

```json
{
	"version": 2,
	"runners": {
		"custom": {
			"command": ["my-agent", "--prompt", "{prompt}"],
			"resumeCommand": ["my-agent", "resume", "{sessionId}", "{prompt}"],
			"environment": { "MY_AGENT_TARGET": "{target}" }
		}
	}
}
```

Available placeholders are `{prompt}`, `{workbase}`, `{target}`, `{task}`,
`{phase}`, `{claimant}`, `{sessionId}`, and `{claimRevision}`. Task and phase
placeholders are empty when they do not apply. If `resumeCommand` is omitted,
the fresh command is also used for resumed sessions.

Every runner receives the same `AGENCY_RUNNER`, `AGENCY_CLAIMANT`,
`AGENCY_SESSION_ID`, `AGENCY_CLAIM_REVISION`, `AGENCY_WORKBASE`, `AGENCY_TARGET`,
`AGENCY_TASK_ID`, `AGENCY_PHASE_ID`, and `AGENCY_PROMPT` environment. Configured
environment is added without overriding these normalized values.
`--print-command` prints the exact cwd and argv plus non-secret environment keys
without launching the runner.

### Custom Chooser Command

Interactive selection uses a native numbered chooser by default. To use an
external chooser, configure an argv command in `agency.json`:

```json
{
	"version": 2,
	"chooserCommand": ["fzf", "--ansi", "--delimiter=\\t", "--with-nth=2.."]
}
```

Agency writes one `key<TAB>label` record per choice to the command's stdin. The
command must write the selected opaque key or selected record to stdout; commands
such as `["gum", "filter"]` therefore work without wrappers. Exit codes 1 and
130, empty stdout, native `q`, and an empty native response cancel selection.
Other nonzero exits, unknown keys, and invalid native numbers are errors.

Selectors are opened only when stdin and stderr are terminals and neither
`--no-input` nor JSON output is active. Labels use color only when stderr is a
terminal, `TERM` is not `dumb`, and `NO_COLOR` is unset; otherwise selectors use
plain labels without ANSI styling or icon-font dependencies.

## Frontmatter

### Epic

```yaml
---
ticketUrl: https://example.com/tickets/checkout
description: Coordinate the checkout experience across frontend and backend.
repos:
  - repo: frontend
    ref: main
  - repo: backend
    ref: main
tasks:
  - id: backend-api
  - id: frontend-ui
    dependsOn:
      - backend-api
---
```

### Single-Phase Task

```yaml
---
ticketUrl: https://example.com/tickets/refresh-copy
description: Refresh user-facing checkout copy.
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
ticketUrl: https://example.com/tickets/build-checkout
description: Deliver checkout through sequenced backend and frontend changes.
epic: checkout
phases:
  - id: backend-api
  - id: frontend-ui
    dependsOn:
      - backend-api
---
```

Each listed phase has a `phases/{id}/PHASE.md` containing its execution fields:

```yaml
---
description: Build the checkout interface against the new backend API.
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

Epic task dependencies belong in `EPIC.md`. Phase dependencies belong in the
owning `TASK.md`. Stable IDs do not encode ordering in directory names.

## Quick Start

```bash
agency workbase init ~/work
cd ~/work

agency repo add frontend git@github.com:example/frontend.git
agency repo link backend ~/Dev/backend

agency task new

agency validate
agency context tasks/refresh-copy --json
agency work tasks/refresh-copy
agency pr create refresh-copy
```

After cloning an existing workbase on another machine, restore its declared
repositories before preparing work:

```bash
agency repo setup --dry-run
agency repo setup --apply
agency validate
```

## Commands

### Target Context

`agency context [target] --json` returns the complete bootstrap context for an
epic, task, or phase without modifying the workbase or fetching repositories.
The target defaults to the current directory; entity directories, document
paths, checkout descendants, and bare task IDs are accepted.

The result includes workbase and target identity, ancestor frontmatter and prose
with SHA-256 hashes, dependency and readiness state, aggregate status, writable
and reference authority, local checkout and resolved-commit state, recorded PR
state, and validation warnings. Only `done` satisfies a dependency; `dropped` is
terminal but remains a blocker.

Complete output is the default. Pass `--compact` explicitly to omit document
prose and low-level Git details while retaining identity, hashes, authority,
paths, graph state, materialization state, and validation warnings.

### Workbase Graph

`agency graph --json` exports the complete workbase as graph contract version 1.
Nodes use stable IDs (`epic:<id>`, `task:<id>`, `phase:<task>/<phase>`,
`repository:<alias>`, and `execution-unit:<kind>/<id>`). Typed edges are `owns`,
`depends_on`, `writes`, and `references`.

Every work node includes status, readiness, `blockedBy`, detailed blockers,
terminal state, reverse dependents, and aggregate progress. Only `done` satisfies
a dependency; `dropped` is terminal but does not satisfy dependents. The graph
summary counts the statuses of all execution units, independent of filters.

```text
agency graph [--json | --jsonl] [--ready | --blocked]
  [--status <status>...] [--repository <alias>...] [--kind <kind>...]
  [--include <bodies|workspace|git|pr>...]
```

Filters are applied after graph state is computed. Returned edges always have
both endpoints in the filtered node set. Durable frontmatter and document hashes
are always present; prose, absolute workspace paths, Git inspection, and live PR
inspection are opt-in include layers.

`--jsonl` emits a versioned `meta` record, one record per node and edge, then an
`end` record with counts. Combining the metadata with the streamed node and edge
records reconstructs the same result as `--json`.

### Next Ready Work

`agency next` lists ready execution units in descending unlock priority, with
their epic and task context. `agency next --select` returns only the highest-
priority ready unit in human output.

`agency next --json` returns the same ranked `ready` set plus every `excluded`
execution unit. Excluded entries retain status, terminal state, `blockedBy`, and
detailed dependency, validation, or status blockers for orchestrators.

`agency work` and `agency pr create` consult this shared readiness model before
materializing or pushing. Blocked, done, and dropped targets are rejected unless
`--force` is supplied explicitly. PR creation permits active `working` and
`delegated` targets when they have no dependency or validation blocker.

### Reconciliation

`agency sync` first compares portable repository declarations with local
materializations, then compares every execution declaration with local branch
and worktree registration, checkout dirtiness, resolved reference commits, claim
expiry, and pull request and merge state. It reports
structured `changes`, `warnings`, `unresolved`, and per-execution evidence. The
default and `--dry-run` modes are observational.

`agency sync --apply` performs only these safe transitions:

- materialize declared but missing repositories from their canonical remotes;
- adopt legacy materializations only when they have an unambiguous portable origin;
- materialize missing checkouts when no registration, branch, or path conflicts;
- release an active claim only after its declared expiry has passed;
- record a single PR whose head and base match the declaration; and
- mark work done after its authoritative PR is merged and no active claim remains.

Apply never overwrites linked or invalid repositories, repairs remote drift,
modifies dirty checkouts, moves worktrees, switches branches, resets reference
commits, chooses among conflicting remotes or PRs, or bypasses active claims.
Those conditions remain visible in `warnings` or `unresolved` with a suggested
action.

### Workbase and Repositories

```text
agency workbase init [path] [--json]
agency init [path] [--json] # Alias
agency workbase add <path> [--name <name>] [--json]
agency workbase list [--json]
agency workbase show <id|name|path> [--json]
agency workbase name <id|name|path> <name> [--json]
agency workbase name <id|name|path> --clear [--json]
agency workbase remove <id|name|path> [--json]
agency workbase prune [--json]
agency workbase default [<id|name|path> | --clear] [--json]
agency integration status [--json]
agency integration sync [--json]
agency repo setup [--dry-run | --apply] [--json]
agency repo add <alias> <remote> [--json]
agency repo link <alias> <path> [--json]
agency repo list [--json]
agency repo show <alias> [--json]
agency repo fetch <alias> [--json]
agency repo remove <alias> [--json]
agency repo unlink <alias> [--json]
agency repo rename <alias> <new-alias> [--json]
agency repo remote <alias> [remote] [--json]
agency repo verify <alias> [--json]
```

Repository JSON output exposes state facets rather than hiding partial setup:
`declared`, `materialized`, `linked`, `missing`, `invalid`, and
`remote-drifted`. A normal bare clone is declared and materialized; a local
checkout is declared and linked; a fresh workbase clone is declared and missing
until setup is applied.

`repo add`, `link`, `remote`, `rename`, and `remove` update the portable
declaration transactionally with local state. `repo remove` removes both the
declaration and an unused local materialization. `repo unlink` removes only this
machine's symlink and retains the declaration, leaving an actionable missing
state. Linking a local checkout over an unused managed clone likewise retains the
portable remote for other machines. `repo remote` updates managed clones but
never mutates an external linked checkout; drift remains visible until that
checkout is updated explicitly. Credential-bearing URLs, file URLs, and local
paths are never accepted as declarations.

Registered workbases are stored in
`$XDG_CONFIG_HOME/agency/workbases.json` (or `~/.config/agency/workbases.json`).
Each registration has a stable ID and may have a unique name. A default workbase
is used when the current directory is outside every workbase. `prune` removes
registrations whose workbase configuration no longer exists.
`repo add` creates a bare clone. `repo link` creates a symlink to an existing Git
repository. Alias names are then used by all documents and commands. Remove,
unlink, and rename refuse aliases referenced by active work or backed by linked
worktrees, and report each blocker.

Commands that print Agency-owned results accept `--json`, including initialization,
integration inspection/sync, repository mutations, entity creation/list/show,
status, validation, graph export, reconciliation, and PR creation.
Entity create, list, and show results include a stable SHA-256 `revision` of the
complete Markdown document.

### Epics

```text
agency epic create <id> --ticket-url <url> [--description <text>] [--json]
  --repo <alias>:<ref> [--repo <alias>:<ref>...]
agency epic list [filters] [--json]
agency epic show <id> [--json]
agency epic update <id> [--ticket-url <url>] [--description <text>]
  [--clear-description] [--repo <alias>:<ref>...] [--json]
agency epic rename <id> <new-id> [--json]
```

Creating a task with `--epic <id>` adds the task to the epic and writes the task
back-reference.

### Tasks

Create a task interactively. Text prompts identify optional values, and known
choices use fzf. This command requires a TTY and fails with `--no-input`:

```text
agency task new [id]
```

Create a single-phase task:

```text
agency task create <id> --repo <alias>
  [--ticket-url <url>] [--description <text>] [--epic <id>]
  [--reference <alias>:<ref>...] [--branch <name>] [--base <name>] [--json]
```

The branch defaults to `task/<id>` and the base defaults to `main`.
`task create` is always noninteractive and requires `--repo` for a single-phase
task. Use it instead of `task new` in scripts and agent workflows.

Create a multi-phase task container:

```text
agency task create <id> --multi-phase
  [--ticket-url <url>] [--description <text>] [--epic <id>] [--json]
```

### Noninteractive Use

Agency never prompts when `--no-input` is set or stdin/stderr are not TTYs.
`--json` also disables prompts and selectors, even when a TTY is available.
Commands with explicit inputs continue normally. `--workbase <id|name|path>`
selects a workbase directly; `--cwd <path>` performs the same inference Agency
would perform from that directory. These options are mutually exclusive and take
precedence over ambient cwd and the configured default.

Targeted commands accept `--epic`, `--task`, and `--phase` where those entity
kinds apply. A phase selector requires a task selector. Entity selectors cannot
be mixed with positional target IDs, and an epic selector cannot be mixed with
task or phase selectors. This makes commands such as
`agency phase status done --task ship --phase release --workbase primary --no-input`
fully independent of process cwd and prompts.

Inspect tasks:

```text
agency task list [filters] [--json]
agency task show <id> [--json]
agency task status <id> <open|done|dropped> [--json]
agency task update <id> [metadata options] [--json]
agency task rename <id> <new-id> [--json]
agency task move <id> (--epic <epic-id> | --no-epic) [--json]
agency task dependency <add|remove> <task-id> <dependency-id> [--json]
```

Task updates can replace or clear descriptions, tickets, repository references,
and pull request URLs, or replace writable repository, branch, and base metadata.
Execution metadata changes refuse to run while code is materialized. Moving a
task with scoped incoming or outgoing dependencies also refuses until those
dependencies are removed.

To add a phase to an existing single-phase task, name the phase that will own
the task's current execution fields with `--first-phase`:

```text
agency phase create refresh-copy verification
  --first-phase implementation
  --repo frontend --branch task/refresh-copy-verification --base main
  --depends-on implementation
```

Agency converts `TASK.md` to the multi-phase shape, creates both phase documents,
and moves existing worktrees from the task's `code/` directory into the first
phase. Dependencies remain explicit through `--depends-on`.

### Phases

```text
agency phase create <task-id> <phase-id>
  --repo <alias> --branch <name> --base <name>
  [--description <text>] [--reference <alias>:<ref>...]
  [--depends-on <phase-id>...] [--first-phase <phase-id>] [--json]

agency phase list <task-id> [filters] [--json]
agency phase show <task-id> <phase-id> [--json]
agency phase status <task-id> <phase-id> <open|done|dropped> [--json]
agency phase update <task-id> <phase-id> [metadata options] [--json]
agency phase rename <task-id> <phase-id> <new-id> [--json]
agency phase dependency <add|remove> <task-id> <phase-id> <dependency-id>
  [--json]
```

Dependency additions append without reordering existing declarations and reject
unknown IDs, self-dependencies, and cycles. Rename operations update structured
references as one rollback-capable mutation and refuse when a materialized
worktree would make the directory move unsafe. Mutation JSON includes changed
paths and the focused validation scope.

Epic, task, and phase update, rename, move, and dependency mutations accept
`--if-revision <hash>`. The option is optional for interactive human use. When
provided, Agency fails with a structured `REVISION_CONFLICT` containing the
expected and current revisions if the target changed. Multi-document mutations
also recheck every affected document after taking the mutation lock and before
writing anything.

Single-phase tasks and phases store status in YAML. New execution units start
`open`, and `agency work` marks the selected execution unit `working` immediately
before launch. Use claims for coordinated ownership and the status subcommands
for manual lifecycle overrides. The interactive work selector displays status
markers before execution units. Existing working and delegated work may be
released to `open` or assigned a terminal outcome. Done and dropped work are
terminal and may only remain unchanged or transition to open; reopen terminal
work before changing its outcome.

`delegated` remains readable for existing workbases but cannot be newly assigned.
Delegation is now explicit: the claimant identifies the orchestrator and the
runner identifies the assigned agent.

Human list output is a compact table with lifecycle, readiness, parent,
repository, branch, recorded PR, and worktree state where applicable. List and
status views accept composable `--status <status>` and `--repository <alias>`
filters, plus `--ready`, `--blocked`, `--pr`, and `--no-pr`. Status and repository
filters are repeatable. Rows follow task and phase declaration order; plain text
labels remain complete without color or icon fonts.

### Claims

Claim mutations require the SHA-256 revision exposed by `agency context` or
`agency graph`. Every operation compares that revision while holding an exclusive
document lock and atomically replaces the execution document.

```text
agency claim <task-id> [phase-id] --claimant <id> --runner <id>
  --session-id <id> --revision <sha256> [--expires-at <timestamp>] [--json]
agency release <task-id> [phase-id] --session-id <id>
  --revision <sha256> [--json]
agency finish <task-id> [phase-id] --session-id <id>
  --revision <sha256> --outcome <done|dropped> [--json]
```

An active claim sets status to `working`. Release returns it to `open`; finish
sets the terminal outcome. Released and finished ownership metadata remains in
frontmatter. Conflicts return the current revision and complete ownership record
in the machine error envelope rather than overwriting it. Expired claims may be
replaced with a revision-guarded claim.

`agency work` claims an execution unit before launching its agent. Set
`AGENCY_CLAIMANT`, `AGENCY_RUNNER`, or `AGENCY_SESSION_ID` to supply orchestrator
identities; otherwise Agency derives them from the user and process. The selected
runner name is recorded on the claim. The launched agent receives the normalized
runner environment documented above for a later release or finish operation.

### Archive

```text
agency archive list [--kind <kind>] [--status <status>] [--repository <alias>]
agency archive show <epic|task> <id>
agency archive show phase <task-id> <phase-id>
agency archive epic <epic-id> [--dry-run] [--json]
agency archive task <task-id> [--dry-run] [--json]
agency archive phase <task-id> <phase-id> [--dry-run] [--json]
agency restore epic <epic-id> [--dry-run] [--json]
agency restore task <task-id> [--dry-run] [--json]
agency restore phase <task-id> <phase-id> [--dry-run] [--json]
```

Archived work keeps its hierarchy under `archive/`. Epic archiving includes its
listed tasks. Task and phase archiving update the active parent document and
reject items that active siblings depend on. Agency removes registered worktrees
before moving files, refuses dirty worktrees, and preserves branches. Archive and
restore preflight all destinations and graph references before changing files.
Versioned lifecycle provenance preserves parent declarations and dependency edges
for restoration. Archived IDs are reserved until restored.

### Work and Pull Requests

```text
agency work [<directory> | --epic <epic-id>] [--runner <name>] [--print-command]
agency work prepare [target] [--dry-run] [--json]
agency worktree <list|inspect|prepare|remove|rebuild|repair>
agency pr create <task-id> [phase-id] [--draft] [--json]
```

`agency work` presents the full hierarchy in `fzf`. Pass a directory, including
`.` for the current directory, to infer its epic, task, or phase. Outside a
workbase, Agency first presents the registered workbases, then the selected
workbase's hierarchy. If `fzf` is not installed, Agency prints the available
choices and asks for an explicit directory.

OpenCode is the default runner, with automatic Claude fallback when neither is
explicitly selected. `--opencode` and `--claude` remain aliases for requiring
their built-in presets.

`agency work prepare` resolves an execution unit and creates or reuses its
writable and reference worktrees without launching an agent or changing status.
Its JSON result includes document and checkout paths, resolved commits, actions,
and Git operations. Use `--dry-run` to report planned fetch, branch, and worktree
changes without applying them.

`agency worktree list` and `inspect` report each declared checkout's expected and
registered path, branch, commit, Agency owner, dirtiness, and conflicts. `prepare`
is the explicit lifecycle form of `agency work prepare`. `remove`, `rebuild`, and
`repair` preflight every writable and reference checkout before changing any of
them and accept `--dry-run`. Removal preserves branches. Rebuild rejects dirty or
conflicting worktrees. Repair is deliberately conservative: it repairs safe Git
registration issues and materializes missing checkouts, but never switches a
branch, resets a commit, or discards uncommitted work.

Epic and multi-phase task targets launch orchestration agents beside their
documents. Single-phase tasks and phases fetch repositories, create or reuse
worktrees under `code/`, and launch an execution agent in the writable checkout
with absolute context paths. An explicit directory or `--epic` target bypasses
the hierarchy chooser.

Each writable `(repo, branch)` pair may belong to only one task or phase. Agency
validation reports duplicate ownership, and `agency work` checks Git's worktree
registry before creating or reusing a checkout. It reuses only an exact
path/branch match; if the branch is checked out elsewhere or the target path has
the wrong branch, the command fails with the conflicting path instead of forcing
another checkout.

Read-only references use `<alias>:<ref>` on the CLI and `{ repo, ref }` in YAML.
Agency resolves the ref to a commit and creates a detached worktree. Existing
reference worktrees are reused only while their commit still matches the declared
ref; use a commit SHA as `ref` when reproducibility matters.

`agency pr create` requires a clean writable worktree. It pushes the branch,
runs `gh pr create --fill`, and writes the returned GitHub PR URL into `pr` in
the owning `TASK.md` or `PHASE.md`.

### Status and Validation

```text
agency status [filters] [--json]
agency validate [path] [--json]
```

Validation checks JSON and YAML parsing, Effect Schema conformance, repository
aliases, parent/child backlinks, phase directories, duplicate references,
unknown dependencies, and dependency cycles. YAML duplicate keys, anchors,
aliases, and custom tags are rejected. When path is omitted outside a workbase,
Agency prompts for a registered workbase.

## Machine Protocol

`--json` emits exactly one JSON value on stdout for success or failure. It takes
precedence over `--silent`; progress, warnings, and verbose diagnostics remain on
stderr. Version 1 success responses have this shape:

```json
{ "version": 1, "ok": true, "result": { "root": "/work/agency" } }
```

Failures exit nonzero and use the same versioned envelope:

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

Every error contains a stable `code`, human-readable `message`, structured
`fields`, and `retryable`. `remediation` is included when Agency knows a specific
recovery action. Version 1 defines these codes:

| Code                      | Meaning                                                   |
| ------------------------- | --------------------------------------------------------- |
| `CLI_USAGE`               | Invalid command, option, argument, or option combination  |
| `WORKBASE_NOT_FOUND`      | No workbase could be resolved                             |
| `WORKBASE_CONFIG_INVALID` | Invalid workbase configuration                            |
| `WORKBASE_REGISTRY_ERROR` | Invalid or inaccessible workbase registry                 |
| `FILE_NOT_FOUND`          | A required path does not exist                            |
| `FILESYSTEM_ERROR`        | A filesystem operation failed                             |
| `FRONTMATTER_INVALID`     | A durable document has invalid frontmatter                |
| `VALIDATION_FAILED`       | Workbase validation reported issues                       |
| `REPOSITORY_ERROR`        | Repository operation failed                               |
| `EPIC_ERROR`              | Epic operation failed                                     |
| `TASK_ERROR`              | Task operation failed                                     |
| `PHASE_ERROR`             | Phase operation failed                                    |
| `CLAIM_ERROR`             | Claim input or lifecycle state is invalid                 |
| `CLAIM_CONFLICT`          | Active or legacy ownership conflicts with an operation    |
| `REVISION_CONFLICT`       | A durable document changed since inspection               |
| `CLAIM_OWNERSHIP`         | The session does not own the active claim                 |
| `ARCHIVE_ERROR`           | Archive operation failed                                  |
| `WORKTREE_ERROR`          | Worktree operation failed                                 |
| `PULL_REQUEST_ERROR`      | Pull request operation failed                             |
| `CONTEXT_ERROR`           | A context target or required document is invalid          |
| `GRAPH_ERROR`             | Workbase graph construction failed                        |
| `EXECUTION_BLOCKED`       | Readiness or lifecycle blockers prevent execution         |
| `SYNC_ERROR`              | Reconciliation validation, inspection, or provider failed |
| `PROCESS_ERROR`           | A child process failed and may be retried                 |
| `PROTOCOL_OUTPUT_ERROR`   | A command violated the machine output contract            |
| `COMMAND_FAILED`          | An otherwise unclassified command failure                 |

The Effect schemas are exported from `@markjaquith/agency` and
`@markjaquith/agency/protocol`. The distributable JSON Schemas are exported as
`@markjaquith/agency/schemas/agency-envelope-v1.json` and
`@markjaquith/agency/schemas/agency-graph-v1.json`. Representative envelope
payloads are exported as `@markjaquith/agency/fixtures/protocol/success.json` and
`@markjaquith/agency/fixtures/protocol/error.json`.

Success, help, and version output exit `0`; usage and command failures exit `1`.
There are no error-specific exit statuses. `graph --jsonl` streams versioned
records on success instead of wrapping them in an envelope; JSONL failures still
use one error envelope. See `skills/agency/references/contracts.md` for revision,
selector, projection, retry, and capability details.

## Agent Skill

`skills/agency/SKILL.md` contains an agent-oriented operating guide for Agency.
Install or link that directory into your agent's skill location when you want
Agency workflows to be discovered automatically.

## Development

```bash
bun install
bun link
bun run build
```

Run focused tests with `bun test <test-file>`. Run formatting with `bun format`.

## License

MIT
