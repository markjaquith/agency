# @markjaquith/agency

Agency manages durable agentic work across repositories. Epics, tasks, and
phases live as Markdown documents in a filesystem-backed workbase. Repository
aliases and managed workspaces provide each execution unit with the code it may
read or write.

## Requirements

- [Bun](https://bun.sh) 1.0 or newer
- Git
- [Jujutsu](https://jj-vcs.github.io/jj/) is preferred when available
- [GitHub CLI](https://cli.github.com/) for `agency pr`
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
  AGENTS.md                # optional user-owned workbase instructions
  .agency/
    AGENTS.md              # managed Agency instructions
  .opencode/
    opencode.jsonc         # managed @agency subagent, instructions, and reference
    tui.jsonc              # managed TUI plugin registration
    plugins/agency-repository-skills.ts # managed workbase access and checkout skills
    tui/agency-debug.ts    # managed /agency-debug TUI diagnostic
  .pi/
    extensions/agency-workbase.ts # managed workbase context and checkout skills
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
`agency integration status` to inspect `.agency/AGENTS.md`, the managed
OpenCode configuration and plugins, and `.pi/extensions/agency-workbase.ts`,
then `agency integration sync` to create missing files or refresh checksum-safe
managed files. Customized files are reported but never overwritten. Sync also
removes checksum-valid retired managed artifacts while
preserving customized files at their former paths. The root
`AGENTS.md` is user-owned and is not inspected or modified by Agency.

The managed `.agency/AGENTS.md` is the complete in-workbase operating contract
for agents. It is created by `agency init`, updated by checksum-safe integration
sync, and requires no separately installed Agency skill. CLI help remains the
source of truth for exact command syntax; this README provides the detailed
product and protocol reference.

When upgrading an existing workbase, synchronization moves a checksum-valid
Agency-managed root `AGENTS.md` to `.agency/AGENTS.md` once the OpenCode config
can load the hidden file. A customized root file, including a symlink, is
preserved as user-owned content.

The OpenCode config defines an `@agency` subagent for delegated workbase
orchestration, loads Agency's hidden instructions in addition to any user-owned
root `AGENTS.md`, advertises the complete workbase as one portable reference,
and replaces the built-in Plan agent with `agency-plan`. That planning agent can
update `TASK.md`, `PHASE.md`, and `EPIC.md`, inspect the workbase through
read-only Agency commands, and use explicit Agency CLI permissions to create or
update planning structure. Its normal research tools and the complete Agency CLI
remain available; managed Agency instructions and reported authority govern each
operation.
When the subagent launches work in another agent, it verifies that the runner
started and returns without waiting for the task to finish.
The TUI-only `/agency-debug` command reports TUI companion initialization and
whether the server plugin registered writable-checkout skills. It uses a native
toast and does not submit a prompt to an LLM. When no writable checkout skill
directory is available, server initialization is reported as indeterminate
rather than inferred from plugin discovery.
OpenCode discovers the config and plugin from task and epic launch directories.
The plugin uses OpenCode's plural discovery directory and exports both the V1
server function and the `opencode2` module wrapper. Integration sync migrates a
checksum-valid legacy singular-path plugin and preserves customized files.
The plugin grants whole-workbase access dynamically, while the portable
reference advertises that context to agents. Bash and Agency operations must
still follow the write authority reported by `agency context`.

Pi discovers the managed project extension automatically when launched from
the workbase root after the project is trusted. When launching Pi from a task,
phase, or epic directory, pass the managed file with `--extension`, for example
`pi -e /path/to/workbase/.pi/extensions/agency-workbase.ts`. The extension loads
the managed Agency instructions into Pi's system prompt, advertises the complete
workbase, and exposes skills from the writable checkout's `.claude/skills`,
`.agents/skills`, `.opencode/{skill,skills}`, and `.pi/skills` directories.
Agency context still determines write authority; reference checkouts remain
read-only.

Repository aliases, the version-control backend, and canonical fetch remotes are
declared in tracked `agency.json`; local clones and symlinks remain ignored under
`repos/{alias}`. A declaration contains no local path, symlink target, checkout,
or credential:

```json
{
	"version": 2,
	"vcs": "jj",
	"repositories": {
		"frontend": {
			"remote": "git@example.com:team/frontend.git"
		}
	}
}
```

New workbases select `"jj"` when the `jj` executable is available and otherwise
select `"git"`. Existing version 2 workbases without `vcs` remain Git workbases.
The selected backend is a workbase-level invariant: jj workbases create
non-colocated managed clones and jj workspaces, while Git workbases continue to
use bare repositories and Git worktrees. Existing colocated jj repositories are
also supported.

Agency uses jj-native commands for repository validity, workspace registration,
working-copy state, revisions, bookmarks, ancestry, fetch, and push. Raw Git is
limited to backing-store plumbing such as durable review refs and integrations
that require Git, including GitHub CLI commit discovery. For those operations,
Agency obtains the backing repository with `jj git root` and supplies it as
`GIT_DIR`; it does not use raw Git to infer jj workspace state.

Inspect the current backend and migration readiness with:

```bash
agency vcs status
agency vcs migrate jj          # dry-run
agency vcs migrate jj --apply
agency vcs migrate git --apply
```

Migration is workbase-wide and transactional. Agency locks every execution
unit, requires clean registered workspaces, blocks active claims and working or
delegated units, converts repository metadata, recreates checkout paths with the
target backend, and updates `agency.json` last. Migration from jj to Git also
blocks jj-only heads that are not preserved by a bookmark or workspace. Failed
migrations restore the source repositories and workspaces when rollback is
possible and report explicit manual recovery paths otherwise.
Converting a non-colocated jj workbase to Git is currently blocked before any
mutation because its backing Git object store is inside `.jj`; first convert the
repositories to colocated jj so the Git store survives metadata removal.

Existing version 2 workbases without `repositories` remain valid. Run
`agency repo setup` to preview deterministic adoption of legacy local aliases;
`agency repo setup --apply` writes declarations only when a portable origin is
unambiguous. Workbase configuration may also provide a custom writable-worktree
creation command.

### Custom Worktree Command

Git workbases create worktrees with Git. Set `worktreeCreateCommand` to an
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

The configured command applies only to the writable checkout of a Git workbase.
Supplemental read-only repositories remain detached Git worktrees at their
declared refs so they do not acquire writable branches. Jj workbases always use
jj workspaces and ignore this Git-specific customization.

### Custom Jj Workspace Command

Jj workbases normally create managed workspaces with `jj workspace add`. Set
`workspaceCreateCommand` to an argv template when another tool should create or
adopt a prepared workspace directly at Agency's destination:

```json
{
	"version": 2,
	"vcs": "jj",
	"workspaceCreateCommand": [
		"my-prewarm-tool",
		"adopt",
		"--repo",
		"{repo}",
		"--destination",
		"{workspace}",
		"--name",
		"{name}",
		"--revision",
		"{revision}"
	]
}
```

Available placeholders are:

- `{repo}`: absolute repository alias path under `repos/`
- `{workspace}`: absolute managed workspace path Agency requires
- `{name}`: unique jj workspace name Agency requires
- `{revision}`: exact commit the new working copy must be based on
- `{kind}`: `writable` or `reference`
- `{requestedRef}`: configured branch, reference, or review commit

`{repo}`, `{workspace}`, `{name}`, and `{revision}` are required. Agency invokes
the command directly without a shell and sets matching `AGENCY_REPO`,
`AGENCY_WORKSPACE`, `AGENCY_WORKSPACE_NAME`, `AGENCY_REVISION`,
`AGENCY_CHECKOUT_KIND`, and `AGENCY_REQUESTED_REF` environment variables. The
command applies to each new jj checkout and must leave `{workspace}` registered
under `{name}` with its working-copy parent at `{revision}`. This lets a prewarm
tool move or adopt a prepared workspace without first paying for Agency's normal
full checkout.

Agency validates the registration, name, path, and revision before running any
`postCheckoutCommand`. A failed command or validation removes a partially
created workspace when possible and otherwise reports manual recovery. Resume
restoration continues to use Agency's built-in exact-target recovery path.
Git workbases ignore this jj-specific customization.

### Post-checkout Commands

Each repository declaration may provide a VCS-neutral `postCheckoutCommand` argv
template for repository-specific setup. Agency invokes it directly, without a
shell, with the new checkout as its working directory:

```json
{
	"version": 2,
	"repositories": {
		"frontend": {
			"remote": "git@example.com:team/frontend.git",
			"postCheckoutCommand": ["bun", "install", "--frozen-lockfile"]
		}
	}
}
```

The hook runs for each newly created managed checkout, including writable and
reference checkouts, after Git worktree or jj workspace creation has completed
and Agency has validated the checkout. It does not run for a reused checkout or
for inspection-only commands. A custom `worktreeCreateCommand` or
`workspaceCreateCommand` completes and is validated before this hook runs.

Available placeholders and matching environment variables are:

| Placeholder        | Environment              | Value                                          |
| ------------------ | ------------------------ | ---------------------------------------------- |
| `{repoAlias}`      | `AGENCY_REPO_ALIAS`      | Repository alias                               |
| `{repositoryPath}` | `AGENCY_REPOSITORY_PATH` | Absolute source repository path under `repos/` |
| `{checkoutPath}`   | `AGENCY_CHECKOUT_PATH`   | Absolute managed checkout path                 |
| `{checkoutKind}`   | `AGENCY_CHECKOUT_KIND`   | `writable` or `reference`                      |
| `{requestedRef}`   | `AGENCY_REQUESTED_REF`   | Requested branch, reference, or review commit  |
| `{base}`           | `AGENCY_BASE`            | Configured execution base                      |
| `{vcs}`            | `AGENCY_VCS`             | `git` or `jj`                                  |
| `{workbaseRoot}`   | `AGENCY_WORKBASE_ROOT`   | Absolute workbase root                         |
| `{taskId}`         | `AGENCY_TASK_ID`         | Task ID                                        |
| `{phaseId}`        | `AGENCY_PHASE_ID`        | Phase ID                                       |

`{base}` and `{phaseId}` and their environment variables are empty strings when
they do not apply. Dry runs report a planned `post-checkout` operation but never
execute it. Verbose output identifies the repository and expanded command.

Hook success is part of checkout creation. A non-zero exit or failure to start
rolls back the checkout and any branch created by the same operation; if cleanup
also fails, Agency reports the exact manual recovery action. A later command
retries checkout creation and the hook rather than reusing an uninitialized
checkout. Hook commands should be idempotent so a retry is safe after any
external effects the failed invocation may have completed.

### Agent Runners

OpenCode (`opencode2` and `opencode`) and Claude Code are built-in runner presets.
Without an explicit runner, Agency uses the first available executable in this
order: `opencode2`, `opencode`, then `claude`. Select a preset or configured
runner with `agency work --runner <name>`. A launch is fresh unless
`AGENCY_SESSION_ID` is already set; resumed launches use the runner's
`resumeCommand` when configured. The built-in presets use `--continue` only for
resumed launches. By default Agency opens the runner without a prompt. `--auto`
uses its autonomous command and sends the generated task, phase, or epic prompt.

Custom runners are direct argv commands, never shell snippets:

```json
{
	"version": 2,
	"runners": {
		"custom": {
			"command": ["my-agent"],
			"autoCommand": ["my-agent", "--prompt", "{prompt}"],
			"resumeCommand": ["my-agent", "resume", "{sessionId}"],
			"autoResumeCommand": ["my-agent", "resume", "{sessionId}", "{prompt}"],
			"environment": { "MY_AGENT_TARGET": "{target}" }
		}
	}
}
```

Available placeholders are `{prompt}`, `{workbase}`, `{target}`, `{task}`,
`{phase}`, `{claimant}`, `{sessionId}`, and `{claimRevision}`. Task and phase
placeholders are empty when they do not apply. `{prompt}` is empty unless
`--auto` is set. If `resumeCommand` is omitted, the fresh command is also used
for resumed sessions. If `autoResumeCommand` is omitted, `autoCommand` is used;
configured runners without `autoCommand` reject `--auto`.

Every runner receives the same `AGENCY_RUNNER`, `AGENCY_CLAIMANT`,
`AGENCY_SESSION_ID`, `AGENCY_CLAIM_REVISION`, `AGENCY_WORKBASE`, `AGENCY_TARGET`,
`AGENCY_TASK_ID`, `AGENCY_PHASE_ID`, and `AGENCY_PROMPT` environment. Configured
environment is added without overriding these normalized values.
Execution-unit runners also receive `AGENCY_WRITABLE_CHECKOUT` with the
authoritative writable checkout path.
`AGENCY_CLAIM_REVISION` is empty for local `agency work` launches.
`AGENCY_PROMPT` is empty unless `--auto` is set.
Autonomous prompts begin `Agency worker launch target: <target>.`, carrying the
same canonical target as `AGENCY_TARGET`. This is the process-local fallback for
runner clients that attach to a long-lived process and lose launch environment
variables. A worker must verify either signal against `agency context . --json`
before acting; a matching worker performs the task directly and must not invoke
`agency work` for the same target. Managed guidance also fails safe for older
generated prompts when their document paths, current directory, and active valid
context all agree. Herdr is not part of this identity contract.
The managed OpenCode plugin validates the marker against Agency context, binds it
to the receiving OpenCode session, injects an explicit active-worker system
instruction, and restores Agency identity for that session's shell environment.
This session bridge is necessary because an OpenCode client can attach to a
long-lived server process that did not inherit the client's launch environment.
The `opencode2` and `opencode` runners remain rooted in their task or epic
working directory so the workbase `AGENTS.md` and managed OpenCode config are
discovered normally.
Agency's managed OpenCode plugin grants the active workbase external-directory
access and adds existing checkout-local `.claude/skills`, `.agents/skills`, and
`.opencode/{skill,skills}` directories to `skills.paths`. The managed Pi
extension provides equivalent whole-workbase context and additionally discovers
checkout-local `.pi/skills` through Pi's `resources_discover` lifecycle.
`agency work` supplies the checkout directly; plain OpenCode launches and Pi
launches with the managed extension loaded resolve a materialized execution-unit
checkout through `agency context`. A multi-phase
task root has no single checkout, so launch from its phase directory when using
plain OpenCode or Pi. Other checkout-local configuration is not composed.
`--print-command` prints the exact cwd and argv plus non-secret environment keys
without launching the runner.

### Custom Chooser Command

Interactive selection uses an OpenTUI Solid split footer by default. Type to
fuzzy-filter choices, use arrow keys or Ctrl-N/Ctrl-P to move, press Enter to
select, and press Escape or Ctrl-C to cancel. To use an external chooser
instead, configure an argv command in `agency.json`:

```json
{
	"version": 2,
	"chooserCommand": ["fzf", "--ansi", "--delimiter=\\t", "--with-nth=2.."]
}
```

Agency writes one `key<TAB>label` record per choice to the command's stdin. The
command must write the selected opaque key or selected record to stdout; commands
such as `["gum", "filter"]` therefore work without wrappers. Exit codes 1 and
130 or empty stdout cancel external selection. Other nonzero exits and unknown
keys are errors.

Selectors are opened only when stdin and stdout are terminals and neither
`--no-input` nor JSON output is active. External chooser labels use color only
when stdout is a terminal, `TERM` is not `dumb`, and `NO_COLOR` is unset. The
native OpenTUI selector uses plain labels without ANSI styling or icon-font
dependencies.

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

Tasks may also record a purpose and one-way investigation handoff provenance:

```yaml
purpose: implementation
handoff:
  source:
    kind: phase
    taskId: investigate-checkout
    phaseId: reproduce
  sourceRevision: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The source revision is historical evidence, not a readiness dependency or a
claim that the source still has that content. Source rename, archive, restore,
or later edits do not rewrite it. Destination rename, archive, and restore
preserve it unchanged. Task show, context, and graph JSON expose the record as
task metadata; graph output does not add an edge for it.

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
cd tasks/refresh-copy
agency pr create --fill
```

After cloning an existing workbase on another machine, restore its declared
repositories before preparing work:

```bash
agency repo setup --dry-run
agency repo setup --apply
agency validate
```

## Commands

### Interactive Actions

`agency act` opens a filterable work-item chooser followed by an action palette
derived from the selected item's current state and readiness. It offers only
actions that can use existing lifecycle semantics, such as working, creating a
pull request, dropping, reopening, or archiving. Cancelling either chooser makes
no changes, and the command refreshes the graph before dispatch so a stale
selection cannot act on changed work.

Use an existing directory, a positional task ID, `--epic <id>`, `--task <id>`,
or `--task <id> --phase <id>` to skip work-item selection. For example,
`agency act .` selects the current task or phase. `--dry-run` still prompts for
an action but prints the exact Agency command instead of executing it. `--json`
never prompts or executes; it returns matching targets, status and readiness
details, document revisions, and each available action's command argv. With no
selector, JSON includes every active work item.

`--auto` is included in generated or executed work commands, and `--draft` is
included in generated or executed pull request commands.

### Target Context

`agency context [target] --json` returns complete bootstrap context without
modifying the workbase or fetching repositories. At the workbase root it returns
a discovery catalog of all epics, tasks, and phases, including frontmatter,
paths, and document revisions. Elsewhere it returns context for an epic, task,
or phase. The target defaults to the current directory; entity directories,
document paths, checkout descendants, and bare task IDs are accepted.
Archived entity paths and selectors are also accepted. Archived context is
explicitly marked with `target.archived: true` and never grants writable
document, repository checkout, or reference authority; restore the item before
attempting mutation or execution.

Root discovery is compact by default and includes a hint to run `agency context
. --full --json` when document prose is needed. Entity context remains complete
by default. `--compact` explicitly requests compact entity context.

The result includes workbase and target identity, ancestor frontmatter and prose
with SHA-256 hashes, dependency and readiness state, aggregate status, writable
and reference authority, local checkout and resolved-commit state, recorded PR
state, and validation warnings. Only `done` satisfies a dependency; `dropped` is
terminal but remains a blocker.

`authority.writable` identifies the writable repository checkout, while
`authority.documents.writable` lists the absolute paths of Agency documents the
target may maintain. A single-phase task lists its `TASK.md`; a phase lists its
owning `TASK.md` and active `PHASE.md`; orchestration targets list none. Use
Agency commands rather than direct edits for structural frontmatter mutations.

Complete output is the default for entity targets. Pass `--compact` explicitly
to omit document prose and low-level Git details while retaining identity,
hashes, authority, paths, graph state, materialization state, and validation
warnings.

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

`agency work` consults this shared readiness model before materializing. Blocked,
done, and dropped targets are rejected unless `--force` is supplied explicitly.
Task-aware `agency pr create` applies Agency readiness and validation checks;
untargeted `agency pr` invocations leave command semantics to `gh`.

### Reconciliation

`agency sync` first compares portable repository declarations with local
materializations, then compares every execution declaration with local branch
and worktree registration, checkout dirtiness, resolved reference commits, claim
expiry, and pull request state, merge state, and mergeability. It reports
structured `changes`, `warnings`, `unresolved`, and per-execution evidence. The
default mode applies safe reconciliation transitions; `--dry-run` is explicitly
observational.

Pass `<task-id>` to scope reconciliation to one task and its repositories. A
multi-phase task scope includes all of its phases; add `[phase-id]` to select one
phase. Scoped sync does not query, materialize, or reconcile unrelated work.

`agency sync` performs only these safe transitions:

- materialize declared but missing repositories from their canonical remotes;
- adopt legacy materializations only when they have an unambiguous portable origin;
- materialize missing checkouts when no registration, branch, or path conflicts;
- release an active claim only after its declared expiry has passed;
- record or refresh a single PR whose head and base match the declaration; and
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
agency epic new <id> --ticket-url <url> [--description <text>]
  --repo <alias>:<ref> [--repo <alias>:<ref>...] [--work [--auto]]
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

Create a task interactively with the OpenTUI Solid footer. When exactly one
repository is available, Agency selects it without presenting a redundant
choice. This command requires a TTY and fails with `--no-input`:

```text
agency task new [id] [--work [--auto]]
```

`--work` starts work on the newly created entity. Add `--auto` to pass the
generated context prompt to the selected runner. These launch options are also
available on `epic new` and `phase new`; they cannot be combined with `--json`.

Create a single-phase task:

```text
agency task create <id> --repo <alias>
  [--ticket-url <url>] [--description <text>] [--epic <id>]
  [--reference <alias>:<ref>...] [--branch <name>] [--base <name>] [--json]
```

The branch defaults to `task/<id>` and the base defaults to `main`.
`task create` is always noninteractive and requires `--repo` for a single-phase
task. Use it instead of `task new` in scripts and agent workflows.

For deterministic callers, creation also accepts recalled context:

```text
agency task create <id>
  --context-repo <alias> --context-base <base> --context-slug <id>
  [--authoritative-source <absolute-path-or-http-url>...] --json
```

Recalled values are used instead of rediscovery but must agree with equivalent
explicit flags. The preferred slug must equal the created ID, repository aliases
are validated by normal task creation, and authoritative sources must be absolute
paths or HTTP(S) URLs.

Machine output adds fields without changing the version 1 protocol envelope. It
includes `selector`, absolute `documentPath`, the document `revision`, full
`validation`, normalized `recalledContext`, and `evidence`. Evidence version 1 is
an auditable local payload containing the canonical workbase root, target and
document identities, aggregate workbase revision, configuration revision,
repository-mapping revision, kickoff-contract version, validity result, recalled
context, and a digest over those fields. It is not a signature or an authority
grant. A different workbase, target, document revision, document set,
configuration, repository mapping, contract version, or payload digest
invalidates reuse. Older creation output without evidence remains compatible;
preflight simply validates again. The published machine schema is
`schemas/agency-kickoff-v1.schema.json`.

Create investigation-only work with the existing task architecture:

```text
agency task create <id> --purpose investigation --repo <alias> [options]
```

This records `purpose: investigation` and generates explicit Investigation
Boundary, Evidence, Findings, Recommendation, Implementation Handoff, and
Important Decisions sections. A no-change recommendation is a valid result;
implementation does not belong in the investigation task merely because that
task has execution authority.

Create a distinct implementation task from an investigation task or phase:

```text
agency task handoff <investigation-task> <new-task> --repo <alias> [options] --json
agency task handoff <investigation-task> <new-task> --source-phase <phase> --repo <alias> [options] --json
```

The destination ID must be new across active and archived work; Agency never
restores, reopens, renames, or reuses a matching item. Explicit requests for a
new, separate, or follow-up item always override reuse, even when the subject or
suggested ID matches existing work. The transaction writes only the destination
task and any requested epic backlink, while revision-checking the source.

JSON returns the exact destination selector, directory and document path,
branch/base and revision; source selector, document path and captured revision;
the validation report; and the later `worktree prepare` target and command.
Handoff creation does not prepare a worktree, change status, launch an agent, or
perform UI actions. Run `agency context <new-task> --json` to verify authority,
and prepare or launch only when separately requested.

Create a multi-phase task container:

```text
agency task create <id> --multi-phase
  [--ticket-url <url>] [--description <text>] [--epic <id>] [--json]
```

Create a pinned, read-only review task from the selected alias's origin:

```text
agency task create <id> --review <alias> --pull-request <url-or-number>
agency task create <id> --review <alias> --ref <remote-ref>
agency review refresh <id> [--if-revision <hash>] [--json]
```

Review creation fetches the source and records its exact 40-character commit.
GitHub pull requests use the base alias's `refs/pull/<number>/head`, including
fork pull requests exposed through that ref. Review workspaces contain one
detached checkout and no writable branch. Source movement is observed separately
from the pin and applied only by `review refresh`; sync, doctor, work, cleanup,
and archive never move the pin implicitly. Dirty or structurally unexpected
review checkouts block refresh and cleanup. Review tasks support normal status
and claim lifecycle, but reject phase conversion and delivery PR operations.
Each active or archived review task owns one internal task-scoped pin ref. A
refresh advances that ref transactionally; failed creation removes it. Archiving
retains the pin so a deleted source can still be restored and inspected.

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
`agency phase status working --task ship --phase release --workbase primary --no-input`
fully independent of process cwd and prompts.

Inspect tasks:

```text
agency task list [filters] [--json]
agency task show <id> [--json]
agency task status <id> <open|working|done|dropped>
  [--no-pull-request --summary <text> [--evidence-url <url>]] [--json]
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
agency phase new <task-id> <phase-id>
  --repo <alias> --branch <name> --base <name> [--work [--auto]]
agency phase create <task-id> <phase-id>
  --repo <alias> --branch <name> --base <name>
  [--description <text>] [--reference <alias>:<ref>...]
  [--depends-on <phase-id>...] [--first-phase <phase-id>] [--json]

agency phase list <task-id> [filters] [--json]
agency phase show <task-id> <phase-id> [--json]
agency phase status <task-id> <phase-id> <open|working|done|dropped>
  [--no-pull-request --summary <text> [--evidence-url <url>]] [--json]
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
before launch. Running `agency work` again can relaunch unclaimed `working` work.
By default, `done` requires an authoritative merged pull request and is applied
by `agency sync`. Work whose intended outcome genuinely requires no pull
request may instead use an explicit `--no-pull-request --summary <text>` status
transition. Agency records the summary, completion time, and optional evidence
URL durably; reopening removes that evidence. This exceptional path refuses work
that already has a recorded pull request.
Use explicit claims only when an external orchestrator needs coordinated
ownership. The interactive work selector displays status markers before
execution units. Existing working and delegated work may be released to `open`
or assigned a terminal outcome. Done and dropped work are terminal and may only
remain unchanged or transition to open; reopen terminal work before changing its
outcome.

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
  --revision <sha256> --outcome <done|dropped>
  [--no-pull-request --summary <text> [--evidence-url <url>]] [--json]
```

An active claim sets status to `working`. Release returns it to `open`. Finish
records the claim outcome and ownership history; a `done` claim outcome leaves
the execution unit `working` until its pull request is merged, while `dropped`
remains terminal. For a genuine non-PR outcome, `--no-pull-request` atomically
records completion evidence, finishes the claim, and sets the execution unit to
`done`; `--summary` is required and `--evidence-url` is optional. Conflicts return
the current revision and complete ownership record in the machine error envelope
rather than overwriting it. Expired claims may be replaced with a
revision-guarded claim.

`agency work` does not claim execution units. It refuses active explicit claims,
marks open execution work `working`, and launches the runner. External
orchestrators use `agency claim`, launch and monitor their runner separately, and
later call `agency release` or `agency finish`.

### Archive

```text
agency archive list [--kind <kind>] [--status <status>] [--repository <alias>]
agency archive show <epic|task> <id>
agency archive show phase <task-id> <phase-id>
agency archive epic <epic-id> [--dry-run] [--json]
agency archive task <task-id> [--dry-run] [--json]
agency archive tasks [--dry-run] [--json]
agency archive phase <task-id> <phase-id> [--dry-run] [--json]
agency restore epic <epic-id> [--dry-run] [--json]
agency restore task <task-id> [--dry-run] [--json]
agency restore phase <task-id> <phase-id> [--dry-run] [--json]
```

Archived work keeps its hierarchy under `archive/`. Epic archiving includes its
listed tasks. A task can be archived only when its effective status is terminal
(`done` or `dropped`). Multi-phase task status is derived from its phases, every
phase must be terminal, and a task with no phases is not eligible.

`archive tasks` plans the maximal safe cohort of terminal tasks and applies by
default; `--dry-run` performs the same preflight without mutation. A dependency
is work required by a candidate, while a dependent is work that requires the
candidate. Dependencies within the selected cohort can be archived together,
but a retained dependent excludes its dependency, including exclusions that
propagate through a dependency chain. Active claims, dirty or otherwise unsafe
managed checkouts, and occupied archive destinations are reported as per-task
skips. Invalid workbase structure and infrastructure failures abort the command.

Task and phase archiving update active parent documents. Agency removes
registered worktrees before moving files, refuses dirty worktrees, and preserves
branches. Bulk application updates shared parents once and archives the entire
selected cohort in one rollback-capable transaction; it never archives an empty
parent epic implicitly. Versioned lifecycle provenance preserves parent
declarations and dependency edges for restoration. Archived IDs are reserved
until restored.

### Work, Publication, and Pull Requests

```text
agency work [<directory> | --epic <epic-id>] [--runner <name>] [--auto] [--print-command]
agency work prepare [target] [--evidence <json-or-path>] [--dry-run] [--json]
agency worktree <list|inspect|prepare|remove|rebuild|repair>
agency push [--json]
agency pr create <task-id> [phase-id] [--draft] [--title <title>] [--head <branch>] [--base <branch>] [--label <label>] [--force] [--json]
agency pr [args...]
```

`agency work` presents the full hierarchy in the native OpenTUI selector or the
configured external chooser. Pass a directory, including `.` for the current
directory, to infer its epic, task, or phase. Outside a workbase, Agency first
presents the registered workbases, then the selected workbase's hierarchy.

Agency automatically uses the first available runner in this order: `opencode2`,
`opencode`, then `claude`. `--opencode` and `--claude` remain aliases for
requiring their corresponding built-in presets. Launches are interactive and
promptless by default; use `--auto` to send Agency's generated context prompt.

`agency work prepare` resolves an execution unit and creates or reuses its
writable and reference worktrees, or its single pinned review checkout, without
launching an agent or changing status.
Its JSON result includes the workspace, validation result, whether supplied
evidence was `reused` or `refreshed` with stable reason strings, refreshed
evidence, and a versioned `agency-kickoff-v1` orchestration plan. The plan has a
deterministic idempotency key and ordered, retry-safe actions for worktree
preflight/preparation, a background tab, side-by-side task document,
`agency work . --auto`, and exactly one final `agency context <document> --json`.
The evidence argument may be an evidence object, task-creation JSON, or a path to
either. Use `--dry-run` to report planned fetch, branch, and worktree changes
without applying them. Validation reuse never skips readiness, active-claim,
repository, ownership, reference-drift, dirty-workspace, or worktree safety
checks.

The authoritative implementation locations for this contract are
`src/commands/task.ts` (creation output),
`src/workbase/kickoff-contract.ts` (evidence and orchestration schemas),
`src/commands/work.ts` (launch preflight),
`src/services/WorktreeService.ts` (workspace safety), and
`src/workbase/AGENTS.md` (generated OpenCode guidance). These paths are the
deterministic source-location fixture for compatible orchestrators.

`agency worktree list` and `inspect` report each declared checkout's expected and
registered path, branch, commit, Agency owner, dirtiness, and conflicts. `prepare`
is the explicit lifecycle form of `agency work prepare`. `remove`, `rebuild`, and
`repair` preflight every writable and reference checkout before changing any of
them and accept `--dry-run`. Removal preserves branches. Rebuild rejects dirty or
conflicting worktrees. Repair is deliberately conservative: it repairs safe Git
registration issues and materializes missing checkouts, but never switches a
branch, resets a commit, or discards uncommitted work.

For jj, explicit removal is a suspend operation. Agency records each workspace's
exact `@` commit and stable change ID in `.agency-jj-resume.json`, roots that
commit with an internal local bookmark, and only then forgets the workspace.
The next `work prepare` validates all three identities, restores the workspace by
editing the recorded commit, and consumes the resume metadata and bookmarks.
Missing, ambiguous, or conflicting resume state stops instead of falling back to
the declared delivery bookmark, `@-`, or the base. Unknown checkout cleanliness
also stops removal. Git worktree removal and preparation are unchanged.

Agency launches every agent beside its epic or task document. Single-phase tasks
and phases first fetch repositories and create or reuse worktrees under `code/`,
then launch the execution agent from the task directory with absolute context
paths. An explicit directory or `--epic` target bypasses the hierarchy chooser.

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

`agency push` publishes the execution unit identified by current Agency context
without creating a pull request. It requires a valid, registered writable
checkout in `working` state, fetches the configured delivery remote, verifies
that the declared base is in the publication history, validates every outgoing
commit's description, author, and conflict state, and refuses non-fast-forward
updates.

For Git, YAML `branch` must exactly match the checked-out local branch, the
worktree must be clean, and `HEAD` is pushed with upstream tracking. For jj, YAML
`branch` is the authoritative delivery bookmark and need not exist before
publication. Agency publishes `@` unless it is the canonical empty, undescribed
post-commit working copy, in which case it publishes `@-`; described empty
changes remain intentional publication tips. Missing descriptions or authors
stop with exact change IDs and remediation commands. Agency creates or safely
advances only the declared bookmark and never invents a `push-*` bookmark.
If the fetched remote base advanced outside the local stack, Agency prints the
exact `jj rebase` command needed to move the stack onto `<base>@<remote>`. Push
reports deterministic fetch, inspection, validation, and publication progress
on stderr, including while `--json` reserves stdout for one machine result.

Task-aware `agency pr create <task-id> [phase-id]` uses Agency's delivery flow,
including readiness checks and durable PR recording. It accepts draft, title,
declared head/base confirmation, and repeatable label options; a contradicting
head or base is rejected rather than recording inconsistent delivery metadata.
Other `agency pr`
invocations forward every argument to `gh pr`. From an execution task or phase
directory, including descendants, passthrough runs in that execution unit's
authoritative writable checkout. Otherwise it runs in the caller's current
directory. In jj workbases, Agency also supplies the repository and the work
item's declared branch to subcommands that would otherwise infer Git context.

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
use one error envelope. Revision and concurrency behavior is documented under
Tasks, Phases, and Claims; selector behavior under Noninteractive Use; projection
behavior under Target Context and Workbase Graph; and retry behavior in the
machine error contract above.

## Development

```bash
bun install
bun link
bun run build
```

Run focused tests with `bun test <test-file>`. Run formatting with `bun format`.

## License

MIT
