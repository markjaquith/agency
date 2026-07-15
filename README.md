# @markjaquith/agency

Agency manages durable epics, tasks, phases, repository references, worktrees,
and pull requests from a filesystem-backed workbase.

## Installation

```bash
bun install -g @markjaquith/agency
```

## Workbase

```text
workbase/
  agency.json
  repos/
  epics/
  tasks/
```

Repository aliases are bare Git repositories or symlinks under `repos/`.
Epics, tasks, and phases are Markdown documents with validated YAML frontmatter.

## Commands

```text
agency init [path]
agency repo add|link|list
agency epic create|list|show
agency task create|list|show
agency phase create|list|show
agency work <task-id> [phase-id]
agency status
agency validate
agency pr create <task-id> [phase-id]
```

Run `agency <command> --help` for command-specific options.

## Development

```bash
bun install
bun link
```

Run focused tests with `bun test <test-file>`.

## License

MIT
