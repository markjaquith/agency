# Agency Command Reference

Use this reference after `agency context . --json` identifies the target. Run
`agency <command> --help` for the exact options supported by the installed CLI.
Commands that return Agency-owned data accept `--json` unless noted otherwise.

## Discovery And Health

```text
agency context [target] [--json] [--compact]
agency graph [--json | --jsonl] [--ready | --blocked]
  [--status <status>...] [--repository <alias>...] [--kind <kind>...]
  [--include <bodies|workspace|git|pr>...]
agency next [--select] [--json]
agency status [filters] [--json]
agency validate [path] [--json]
agency doctor [--json]
agency sync [--dry-run | --apply] [--json]
agency integration status [--json]
agency integration sync [--json]
```

`context` defaults to cwd and accepts entity directories, document paths,
checkout descendants, or a task ID. Complete output includes prose and Git
details; `--compact` intentionally omits them. `graph` computes readiness before
applying filters. `doctor` discovers required tools, integrations, repositories,
refs, worktrees, permissions, drift, and optional runner capabilities. `sync` is
observational unless `--apply` is explicit.

## Workbase And Repositories

```text
agency init [path] [--json]
agency workbase add <path> [--name <name>] [--json]
agency workbase list [--json]
agency workbase show <id|name|path> [--json]
agency workbase name <id|name|path> (<name> | --clear) [--json]
agency workbase default [<id|name|path> | --clear] [--json]
agency workbase remove <id|name|path> [--json]
agency workbase prune [--json]
agency repo add <alias> <remote> [--json]
agency repo link <alias> <path> [--json]
agency repo list [--json]
agency repo show <alias> [--json]
agency repo fetch <alias> [--json]
agency repo remote <alias> [remote] [--json]
agency repo verify <alias> [--json]
agency repo rename <alias> <new-alias> [--json]
agency repo remove <alias> [--json]
agency repo unlink <alias> [--json]
```

`repo add` creates a bare clone; `repo link` creates a symlink to an existing
repository. Removal, unlink, and rename refuse active references or linked
worktree conflicts.

## Epics, Tasks, And Phases

```text
agency epic create <id> --ticket-url <url> [--description <text>]
  --repo <alias>:<ref>... [--json]
agency epic list [filters] [--json]
agency epic show <id> [--json]
agency epic update <id> [metadata options] [--if-revision <hash>] [--json]
agency epic rename <id> <new-id> [--if-revision <hash>] [--json]

agency task new [id]
agency task create <id> --repo <alias> [--ticket-url <url>]
  [--description <text>] [--epic <id>] [--reference <alias>:<ref>...]
  [--branch <name>] [--base <name>] [--json]
agency task create <id> --multi-phase [--ticket-url <url>]
  [--description <text>] [--epic <id>] [--json]
agency task list [filters] [--json]
agency task show <id> [--json]
agency task status <id> <open|done|dropped> [--json]
agency task update <id> [metadata options] [--if-revision <hash>] [--json]
agency task rename <id> <new-id> [--if-revision <hash>] [--json]
agency task move <id> (--epic <epic-id> | --no-epic) [--json]
agency task dependency <add|remove> <task-id> <dependency-id> [--json]

agency phase create <task-id> <phase-id> --repo <alias> --branch <name>
  --base <name> [--description <text>] [--reference <alias>:<ref>...]
  [--depends-on <phase-id>...] [--first-phase <phase-id>] [--json]
agency phase list <task-id> [filters] [--json]
agency phase show <task-id> <phase-id> [--json]
agency phase status <task-id> <phase-id> <open|done|dropped> [--json]
agency phase update <task-id> <phase-id> [metadata options]
  [--if-revision <hash>] [--json]
agency phase rename <task-id> <phase-id> <new-id>
  [--if-revision <hash>] [--json]
agency phase dependency <add|remove> <task-id> <phase-id> <dependency-id>
  [--json]
```

`task new` is interactive and requires a TTY. Agents and scripts use
noninteractive `task create`. Mutation commands that accept `--if-revision`
return a revision conflict instead of overwriting changed documents.

## Ownership And Lifecycle

```text
agency claim <task-id> [phase-id] --claimant <id> --runner <id>
  --session-id <id> --revision <sha256> [--expires-at <timestamp>] [--json]
agency release <task-id> [phase-id] --session-id <id>
  --revision <sha256> [--json]
agency finish <task-id> [phase-id] --session-id <id>
  --revision <sha256> --outcome <done|dropped> [--json]

agency archive list [--kind <kind>] [--status <status>]
  [--repository <alias>]
agency archive show <epic|task> <id>
agency archive show phase <task-id> <phase-id>
agency archive epic <epic-id> [--dry-run] [--json]
agency archive task <task-id> [--dry-run] [--json]
agency archive phase <task-id> <phase-id> [--dry-run] [--json]
agency restore epic <epic-id> [--dry-run] [--json]
agency restore task <task-id> [--dry-run] [--json]
agency restore phase <task-id> <phase-id> [--dry-run] [--json]
```

Claim mutations require the current execution-document revision. Archive and
restore preflight graph and destination safety, remove registered clean
worktrees when needed, preserve branches, and retain lifecycle provenance.

## Worktrees, Launch, And Pull Requests

```text
agency work [<directory> | --epic <id>] [--runner <name>] [--print-command]
agency work prepare [target] [--dry-run] [--json]
agency worktree list [--json]
agency worktree inspect <task-id> [phase-id] [--json]
agency worktree prepare <task-id> [phase-id] [--dry-run] [--json]
agency worktree remove <task-id> [phase-id] [--dry-run] [--json]
agency worktree rebuild <task-id> [phase-id] [--dry-run] [--json]
agency worktree repair <task-id> [phase-id] [--dry-run] [--json]
agency pr create <task-id> [phase-id] [--draft] [--json]
```

`work` is a launch flow, not an active-agent step. `work prepare` materializes
without launching or changing status. Worktree mutations preflight every
declared checkout and refuse dirty or conflicting state. `pr create` requires a
clean writable checkout, pushes the declared branch, invokes `gh pr create
--fill`, and records the returned URL.

## Noninteractive Selection

Use global `--workbase <id|name|path>` outside a workbase, or `--cwd <path>` to
perform cwd inference elsewhere. Targeted commands accept `--epic`, `--task`,
and, with a task, `--phase`. `--json`, `--no-input`, or non-TTY execution disables
prompts; provide all selectors and required inputs explicitly.
