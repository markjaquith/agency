---
name: agency
description: >
  Operate Agency workbases, epics, tasks, phases, execution worktrees, claims,
  and pull requests. Use when inspecting or changing Agency-managed work,
  coordinating dependencies, launching agents, or finishing an execution unit.
license: MIT
compatibility: Requires the agency CLI and Git. Agent launch requires OpenCode, Claude, or a configured runner; default GitHub delivery requires gh.
---

# Agency

Agency keeps plans and lifecycle state in durable Markdown documents and keeps
portable repository aliases in `agency.json`. Bare repositories under `repos/`
and Git checkouts under `code/` are ignored local materializations. Treat tracked
workbase state as authoritative and Agency commands as the safe mutation path.

## Start With Context

For an entity target, the first inspection command is:

```bash
agency context . --json
```

It identifies the target and ancestors, document revisions, dependency
readiness, write authority, checkout state, PR state, and validation warnings.
Use its paths and IDs instead of inferring them from the process cwd.

At the workbase root, context cannot infer one entity from `.`. Use
`agency next --json` or `agency graph --json` to choose a target, then inspect it
with explicit `--epic`, `--task`, and `--phase` selectors or its returned document
path. Do not pass a graph node key as a positional context target.

For broader orchestration, load the graph and discover available capabilities:

```bash
agency graph --json
agency doctor --json
agency --help
agency <command> --help
```

Use `agency next --json` when choosing ready execution work. Read
[`references/contracts.md`](references/contracts.md) when consuming machine
output or editing documents.

## Mental Model

- A **workbase** contains durable epics, tasks, phases, and repository aliases.
- A repository declaration stores an alias and credential-free canonical fetch
  remote; local bare clones and linked checkouts are replaceable machine state.
- An **epic** coordinates tasks. It may inspect repositories but never writes code.
- A **task** is one durable outcome. It is either an execution unit itself or a
  container for phases.
- A **phase** is one execution unit within a multi-phase task, normally one PR.
- An **execution unit** has exactly one writable `repo`, optional read-only
  `repos`, one branch, one base, and one recorded PR value.
- `open` is eligible for readiness evaluation, `working` is actively owned, and
  `done` or `dropped` is terminal. An open unit may still be blocked; only `done`
  satisfies a dependency.

The `authority` returned by context is decisive. Write only through
`authority.writable.checkoutPath`. Every entry in `authority.references` is
read-only, even if filesystem permissions permit writes.

## Decide Before Acting

Require explicit user intent before:

- initializing a workbase;
- adding, linking, renaming, or removing a repository alias;
- applying repository setup or sync changes;
- launching another agent with `agency work` from an active agent session;
- creating a pull request;
- archiving, restoring, dropping, or reopening work; or
- using `--force` to override readiness.

Use a single-phase task for one outcome delivered by one PR. Use phases when an
outcome needs multiple PRs or ordered execution units. Use an epic when several
independently meaningful tasks need coordination.

## Safety Invariants

- Keep task-wide decisions in `TASK.md` and phase delivery details in `PHASE.md`.
- Never write through plural `repos` references.
- Never edit bare repositories or repository symlinks under `repos/`.
- Never persist local paths, symlink targets, worktrees, or credentials as
  repository remotes.
- Never manually create, move, or remove generated `code/` worktrees.
- Never invent IDs, revisions, PR URLs, dependency completion, or checkout state.
- Preserve parent backlinks and dependency declarations; use Agency mutations
  instead of hand-editing structural frontmatter.
- Run `agency validate` before worktree or PR operations and after structural edits.
- Do not bypass dirty-worktree, active-claim, revision, or readiness protections.

## Operating Protocol

### Start

1. Run `agency context . --json`.
2. Confirm `target`, `graph.readiness`, `authority`, `workspace`, and `validation`.
3. Read the returned task and phase document paths for prose requirements.
4. Stop on validation errors, dependency blockers, an unexpected writable
   repository, or a conflicting active owner. For an active agent, a `working`
   status blocker is expected only when the current session owns the claim.

### Work

1. Change files only in the declared writable checkout.
2. Keep durable status and decisions current as the work changes.
3. Validate structure after Agency document mutations.
4. Run repository-specific formatting, type checks, builds, dead-code checks,
   and focused tests before committing.
5. Review the diff and commit according to the repository's instructions.

### Finish

1. Re-run `agency validate` and repository checks.
2. Create a PR only when requested: `agency pr create <task> [phase]`.
3. Record terminal state only when the requested outcome is true. A created PR
   alone does not make work `done` if completion requires merge.
4. If the session has a claim, use revision-guarded `agency finish`; otherwise
   use the task or phase status command. Use `dropped` only for intentionally
   abandoned work.
5. Report the durable status and PR URL. Do not manually remove the worktree.

## Human Launch vs Active Agent

`agency work` is a human/orchestrator launch flow. It first reconciles managed
integration files, then selects work and checks readiness. For an execution unit,
it materializes managed checkouts, claims the unit, marks it working, and starts
the selected built-in or configured runner. Epic and multi-phase task launches
start in orchestration context without materializing or claiming execution work.

An agent already running in an Agency checkout must not call `agency work` to
start itself again. It should inspect context, perform the assigned work, and
finish or release its existing claim. Launch a nested or replacement agent only
when the user explicitly asks.

Use [`references/recipes.md`](references/recipes.md) for human setup, agent
execution, claim, PR, conversion, and recovery workflows. Use
[`references/commands.md`](references/commands.md) only when exact command syntax
is needed.
