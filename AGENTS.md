---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
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

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.md`.

# Agency

This is a CLI tool called `agency` that helps you set up and manage `AGENTS.md` files in your projects. It provides commands to initialize, save, and templatize these files.

It is meant to be used in projects where you don't own the `AGENTS.md` file, but you want to apply certain configurations or templates to it. For instance, when working on a specific feature branch, you would have your `AGENTS.md` template that describes your specific requirements for working this this project as well as layering on your instructions for the feature you're building. That way, LLM agents that read `AGENTS.md` will immediately understand the context of your work and how to assist you.

## Commands

- `agency init [path]`: Initializes `AGENTS.md` file using templates. On first run, prompts for a template name and saves it to `.git/config`. Subsequent runs use the saved template.
- `agency use [template]`: Set which template to use for this repository. Shows interactive selection if no template name provided. Saves to `.git/config`.
- `agency save`: Saves current `AGENTS.md` file back to the configured template directory.
- `agency source [template]`: Returns the path to a template's source directory. Shows interactive selection if no template name provided.
- `agency switch`: Toggles between source branch and PR branch. If on a PR branch (e.g., `main--PR`), switches to source branch (e.g., `main`). If on source branch, switches to PR branch. PR branch must exist first.
- `agency pr [branch]`: Creates a PR branch with managed files reverted to their merge-base state (removes modifications made on feature branch). Default branch name is current branch with `--PR` suffix.

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

**Scope (optional):** The area of the codebase affected (e.g., `cli`, `pr`, `init`, `use`)

**Examples:**

- `feat(pr): add support for custom branch patterns`
- `fix(init): handle missing template directory`
- `test: add tests for source command`
- `chore: update dependencies`

The repository has validation scripts:

- `scripts/check-commit-msg` - Validates commit messages locally
- GitHub Actions workflow validates PR titles


## Formatting before committing

Before committing changes, run the following command to format the code:

```sh
bun format
```
