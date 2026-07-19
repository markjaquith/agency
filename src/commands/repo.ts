import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { RepositoryService } from "../services/RepositoryService"
import { createLoggers } from "../utils/effect"

interface RepoOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly json?: boolean
	readonly apply?: boolean
	readonly dryRun?: boolean
}

const requireArg = (args: readonly string[], index: number, usage: string) =>
	args[index] ? Effect.succeed(args[index]) : Effect.fail(new Error(usage))

export const repo = (options: RepoOptions) =>
	Effect.gen(function* () {
		const repositories = yield* RepositoryService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()

		switch (options.subcommand) {
			case "setup": {
				const result = yield* repositories.setup({
					cwd,
					apply: options.apply === true,
				})
				if (options.json) {
					log(JSON.stringify(result, null, 2))
					return
				}
				if (result.actions.length === 0) log("Repository setup is current")
				for (const action of result.actions) {
					log(
						`${action.status === "applied" ? "Applied" : "Planned"} ${action.kind} '${action.alias}' from ${action.remote}`,
					)
				}
				for (const issue of result.unresolved) {
					log(`Unresolved '${issue.alias}': ${issue.message}. ${issue.action}`)
				}
				return
			}

			case "add": {
				const [alias, remote] = options.args
				if (!alias || !remote) {
					return yield* Effect.fail(
						new Error("Usage: agency repo add <alias> <remote>"),
					)
				}
				const path = yield* repositories.add(alias, remote, cwd)
				log(
					options.json
						? JSON.stringify({ alias, path }, null, 2)
						: `Added repository '${alias}'`,
				)
				return
			}

			case "link": {
				const [alias, path] = options.args
				if (!alias || !path) {
					return yield* Effect.fail(
						new Error("Usage: agency repo link <alias> <path>"),
					)
				}
				const destination = yield* repositories.link(alias, path, cwd)
				log(
					options.json
						? JSON.stringify({ alias, path: destination }, null, 2)
						: `Linked repository '${alias}'`,
				)
				return
			}

			case "list": {
				const items = yield* repositories.list(cwd)
				if (options.json) {
					log(JSON.stringify(items, null, 2))
					return
				}
				for (const item of items) {
					const detail =
						item.target ?? item.remote ?? item.declaredRemote ?? item.path
					log(`${item.alias}\t${item.states.join(",")}\t${detail}`)
				}
				return
			}

			case "show": {
				const alias = yield* requireArg(
					options.args,
					0,
					"Usage: agency repo show <alias>",
				)
				const item = yield* repositories.show(alias, cwd)
				log(
					options.json
						? JSON.stringify(item, null, 2)
						: `${item.alias}\t${item.states.join(",")}\t${item.target ?? item.remote ?? item.declaredRemote ?? item.path}`,
				)
				return
			}

			case "fetch": {
				const alias = yield* requireArg(
					options.args,
					0,
					"Usage: agency repo fetch <alias>",
				)
				const item = yield* repositories.fetch(alias, cwd)
				log(options.json ? JSON.stringify(item, null, 2) : `Fetched '${alias}'`)
				return
			}

			case "remove":
			case "unlink": {
				const alias = yield* requireArg(
					options.args,
					0,
					`Usage: agency repo ${options.subcommand} <alias>`,
				)
				const item = yield* repositories[options.subcommand](alias, cwd)
				log(
					options.json
						? JSON.stringify(item, null, 2)
						: `${options.subcommand === "unlink" ? "Unlinked" : "Removed"} '${alias}'`,
				)
				return
			}

			case "rename": {
				const alias = yield* requireArg(
					options.args,
					0,
					"Usage: agency repo rename <alias> <new-alias>",
				)
				const newAlias = yield* requireArg(
					options.args,
					1,
					"Usage: agency repo rename <alias> <new-alias>",
				)
				const item = yield* repositories.rename(alias, newAlias, cwd)
				log(
					options.json
						? JSON.stringify(item, null, 2)
						: `Renamed '${alias}' to '${newAlias}'`,
				)
				return
			}

			case "remote": {
				const alias = yield* requireArg(
					options.args,
					0,
					"Usage: agency repo remote <alias> [remote]",
				)
				const item = yield* repositories.remote(alias, options.args[1], cwd)
				log(
					options.json
						? JSON.stringify(item, null, 2)
						: (item.declaredRemote ?? "No portable remote declared"),
				)
				return
			}

			case "verify": {
				const alias = yield* requireArg(
					options.args,
					0,
					"Usage: agency repo verify <alias>",
				)
				const report = yield* repositories.verify(alias, cwd)
				if (options.json) log(JSON.stringify(report, null, 2))
				if (!report.valid) {
					return yield* Effect.fail(
						new Error(
							`Repository '${alias}' verification failed:\n${report.issues.map((issue) => `- ${issue}`).join("\n")}`,
						),
					)
				}
				if (!options.json) log(`Verified repository '${alias}'`)
				return
			}

			default:
				return yield* Effect.fail(
					new Error(
						"Subcommand is required. Available subcommands: setup, add, link, list, show, fetch, remove, unlink, rename, remote, verify",
					),
				)
		}
	})

export const help = `
Usage: agency repo <subcommand>

Subcommands:
  setup                 Plan or apply portable repository setup
  add <alias> <remote>  Create a bare clone
  link <alias> <path>   Link an existing Git repository
  list                  List repository aliases
  show <alias>          Show a repository alias
  fetch <alias>         Fetch and prune a repository
  remove <alias>        Remove a declaration and local materialization
  unlink <alias>        Remove only this machine's linked checkout
  rename <old> <new>    Rename an unused repository alias
	remote <alias> [url]  Show or update the portable remote declaration
  verify <alias>        Verify repository operation

Options:
  --dry-run             Report setup changes without applying them (default)
  --apply               Apply safe setup changes
  --json                Output repository aliases as JSON
`
