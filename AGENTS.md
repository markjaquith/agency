# Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

**IMPORTANT: Never run `bun test` without specifying a file!** The full test suite takes 2+ minutes and will likely time out or fail. Always run tests for individual files:

```sh
# Good - run a specific test file
bun test src/commands/init.test.ts

# Bad - never do this
bun test
```

The tests are slow because they create real git repositories and run actual git commands. Fast tests (like `task-parser.test.ts`) don't use git and complete in milliseconds.

**Important:** Tests should not produce extraneous output. When using `verboseLog` or similar logging in implementation code, ensure that the logger respects the `silent` and `verbose` options passed through the command options. Helper functions should accept and forward these options to `createLoggers()` to prevent unwanted output during test runs.

# Agency

This is a CLI tool called `agency` that helps you do agentic coding in projects where you you cannot assert full ownership. For example, you don't own `AGENTS.md` or `CLAUDE.md`, and can't just create them. And you want a way to store notes about a task (branch) you are working on, but want to clean those files out before pushing a public branch.

## Architecture

The codebase uses Effect TS for type-safe, composable error handling and dependency injection. The architecture follows these patterns:

### Services

Core functionality is organized into Effect services that provide clean interfaces and typed error handling:

- **GitService**: All git operations with proper error types (GitError, NotInGitRepoError, GitCommandError)
- **ConfigService**: Configuration management with schema validation using @effect/schema
- **PromptService**: User input operations with readline integration
- **TemplateService**: Template discovery and management
- **FileSystemService**: Comprehensive file I/O operations
- Etc

### Error Handling

Services use tagged error types for specific failure modes:

```typescript
export class GitError extends Data.TaggedError("GitError")<{
	message: string
	cause?: unknown
}> {}

export class ConfigError extends Data.TaggedError("ConfigError")<{
	message: string
	cause?: unknown
}> {}
```

### Schema Validation

All data types are validated using @effect/schema for runtime type safety:

```typescript
import { Schema } from "@effect/schema"

export const AgencyMetadata = Schema.Struct({
	version: Schema.Literal(1),
	managedFiles: Schema.Array(ManagedFile),
	// ...
})
```

### Command Pattern

Commands follow a consistent pattern with Effect-based implementations and backward-compatible async wrappers:

```typescript
// Effect implementation
export const commandEffect = (options) =>
	Effect.gen(function* () {
		const service = yield* ServiceName
		// ... implementation
	})

// Backward-compatible wrapper
export async function command(options) {
	const program = commandEffect(options).pipe(
		Effect.provide(ServiceNameLive),
		Effect.catchAllDefect((defect) =>
			Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
		),
	)
	await Effect.runPromise(program)
}
```

## Commands

- `agency init [path]`: Initializes `AGENTS.md` file using templates. On first run, prompts for a template name and saves it to `.git/config`. Subsequent runs use the saved template.
- `agency template use [template]`: Set which template to use for this repository. Shows interactive selection if no template name provided. Saves to `.git/config`.
- `agency save`: Saves current `AGENTS.md` file back to the configured template directory.
- `agency source [template]`: Returns the path to a template's source directory. Shows interactive selection if no template name provided.
- `agency switch`: Toggles between source branch and emit branch. If on an emit branch (e.g., `feature-x`), switches to source branch (e.g., `agency/feature-x`). If on source branch, switches to emit branch.
- `agency emit [branch]`: Creates an emit branch with managed files reverted to their merge-base state (removes modifications made on feature branch). Default branch name is current branch with `--PR` suffix.
- `agency push`: Creates an emit branch and then pushes it to remote.

## Error Handling

Commands should throw errors with descriptive messages. The CLI handler (cli.ts) is responsible for displaying errors to the user with the "ⓘ" prefix. Commands should NOT call console.error() directly - they should just throw Error objects with clear messages.

Example:

```typescript
// In command file - DON'T do this:
console.error("ⓘ Not in a git repository")
throw new Error("Not in a git repository")

// Instead, do this:
throw new Error(
	"Not in a git repository. Please run this command inside a git repo.",
)
```

The CLI handler will catch the error and display: `ⓘ Not in a git repository. Please run this command inside a git repo.`

## Commit Messages

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <description>
```

**Types:**

- `feat`: A new feature
- `fix`: A bug fix
- `refactor`: Code changes that neither fix a bug nor add a feature
- `test`: Adding or updating tests
- `chore`: Maintenance tasks (dependencies, tooling, etc.)
- `docs`: Documentation changes
- `style`: Code style changes (formatting, missing semicolons, etc.)
- `perf`: Performance improvements
- `ci`: CI/CD configuration changes

**Scope (optional):** The area of the codebase affected (e.g., `cli`, `emit`, `init`, `use`)

**Examples:**

- `feat(emit): add support for custom branch patterns`
- `fix(init): handle missing template directory`
- `test: add tests for source command`
- `chore: update dependencies`

**Breaking Changes:**

For breaking changes, put "BREAKING CHANGE: {change}" in the commit body (not on the first line).

**Skip Release:**

For changes that don't affect the code (e.g., documentation, tests), add `[skip release]` in the commit body to prevent a new release.

## Commit Message Validation

The repository has validation scripts:

- `scripts/check-commit-msg` - Validates commit messages locally
- GitHub Actions workflow validates PR titles

## Releases

This project uses [semantic-release](https://semantic-release.gitbook.io/semantic-release/) for automated versioning and changelog generation. Releases are triggered automatically on merge to `main` based on conventional commit messages:

- `feat:` commits trigger a **minor** version bump
- `fix:` commits trigger a **patch** version bump
- `feat!:` or commits with `BREAKING CHANGE:` trigger a **major** version bump

No manual versioning or changeset files are required.

## Installing Development Version

To install the development version of this CLI tool globally:

```sh
bun link
```

This registers the package so the `agency` command is available system-wide. After running `bun link`, you can use the `agency` command from anywhere.

**Note:** Do NOT use `bun i -g .` as it causes a dependency loop error in Bun.

## Formatting before committing

Before committing changes, run the following command to format the code:

```sh
bun format > /dev/null
```

## Help Documentation Policy

Keep help text concise and focused. Avoid verbose examples that demonstrate standard CLI patterns.

**Guidelines:**

1. **Don't show standard flag examples** - Flags like `--help`, `--silent`, `--verbose`, and `--version` are self-explanatory and don't need examples
2. **Limit examples to 1-3 per command** - Show only the most common use cases that demonstrate core functionality
3. **Avoid redundancy** - If a flag is documented in the Options section, don't also show it in every example
4. **Focus on what's unique** - Examples should demonstrate the command's specific behavior, not generic CLI usage

**Bad (too verbose):**

```
Examples:
  agency switch                  # Toggle between branches
  agency switch --silent         # Switch without output
  agency switch --verbose        # Switch with verbose output
  agency switch --help           # Show this help message
```

**Good (concise):**

```
Example:
  agency switch                  # Toggle between branches
```

**When to show options in examples:**

- Command-specific flags that change behavior significantly (e.g., `--force`, `--template`)
- Non-obvious flag combinations
- Flags that users commonly need (e.g., setting a base branch)

**Review checklist when adding help text:**

- [ ] Does each example demonstrate unique functionality?
- [ ] Have I removed examples for `--help`, `--silent`, `--verbose`, `--version`?
- [ ] Are there more than 3 examples? (If yes, can I reduce it?)
- [ ] Would a user understand the command with fewer examples?
