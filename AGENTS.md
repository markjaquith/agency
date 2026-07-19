# Agency

Agency is a Bun-based TypeScript CLI for managing agentic work across
repositories. Durable epics, tasks, and phases live in a version 2 workbase;
repository aliases and managed execution worktrees provide local code access.

Use `README.md` and `agency <command> --help` as the source of truth for the
current command surface. Do not duplicate the complete command inventory here.

## Tooling

Use Bun for this repository:

- `bun install` installs dependencies.
- `bun run build` builds the CLI.
- `bun run format` formats the repository; `bun run format:check` verifies it.
- `bunx tsc --noEmit` checks TypeScript.
- `bun run knip` checks for unused production code.
- `bun link` installs the development CLI globally.

Run TypeScript files and package scripts with Bun rather than introducing a
second runtime or package manager.

## Testing

Tests use `bun:test`. During development, run the specific affected test file:

```sh
bun test src/commands/init.test.ts
```

Do not run bare `bun test`. The tests create real Git repositories and execute
real Git commands, so the unpartitioned suite is slow. Use `bun run test` only
when intentionally running the repository's full parallel test suite.

Frontmatter and other in-process tests are fast. Repository and worktree tests
are comparatively expensive.

Tests must not produce incidental output. Commands and helpers that log should
accept and forward `silent`, `verbose`, and `json` options to `createLoggers()`.

## Architecture

The codebase uses Effect for dependency injection, typed failures, and command
composition.

- Core capabilities are `Effect.Service` implementations under `src/services/`.
- Commands under `src/commands/` return Effects and obtain capabilities by
  yielding services.
- Services use specific `Data.TaggedError` types for expected failure modes.
- The CLI assembles service layers and owns final human or machine rendering.
- External, durable, configuration, frontmatter, and machine-protocol data is
  runtime-validated with `@effect/schema`.

Keep domain logic in services rather than CLI argument handling. Prefer using an
existing service over adding direct filesystem, process, Git, or GitHub access
to a command.

### Files And Processes

Service code should use `FileSystemService` for filesystem and subprocess work.
Low-level process execution belongs in `spawnProcess`; do not introduce another
subprocess library or an independent command runner.

The existing filesystem service intentionally uses both Bun and Node filesystem
APIs. Follow the local abstraction instead of enforcing one API everywhere.

### Domain Model

The principal durable model is:

- A workbase contains repository aliases, epics, tasks, phases, and generated
  execution worktrees.
- An epic groups dependent work but is not itself an execution unit.
- A single-phase task is an execution unit; a multi-phase task contains phase
  execution units.
- Claims coordinate revision-guarded execution ownership.
- Context, graph, readiness, and sync services expose and reconcile workbase
  state.
- Pull-request delivery is provider-aware; GitHub is the default, not a required
  implementation assumption.

Structural mutations should preserve document relationships, revisions, and
transactional rollback behavior. Use the existing graph and lifecycle services
rather than editing related documents or worktrees ad hoc.

## Errors And Output

Commands and services should fail with descriptive errors; they should not call
`console.error()` to render command failures. The CLI owns presentation:

- Human mode formats failures for the terminal.
- JSON and JSONL modes emit structured protocol envelopes or records.

Do not add output that bypasses this distinction. When adding a tagged error,
consider whether `src/protocol.ts` needs a stable machine error-code mapping.

Use `createLoggers()` for normal command output. Ensure `silent` suppresses
ordinary and verbose output, `verbose` controls diagnostics, and `json` routes
results through the machine-output collector.

## Contributions

Commit subjects follow Conventional Commits:

```text
<type>(<optional-scope>): <description>
```

Use one of `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `style`, `perf`,
or `ci`. Put breaking-change details in a `BREAKING CHANGE:` commit body.
Semantic release runs from `main`; do not edit versions or add changesets
manually.

Before committing code, run the focused tests for the changed behavior and
`bun run format`. Run `bun run pushable` when a full local verification is
warranted.

Keep CLI help concise. Document options once, omit examples for standard global
flags, and include no more than a few examples that demonstrate behavior unique
to the command.
