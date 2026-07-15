import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { RepositoryService } from "../services/RepositoryService"
import { createLoggers } from "../utils/effect"

interface RepoOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args: readonly string[]
	readonly json?: boolean
}

export const repo = (options: RepoOptions) =>
	Effect.gen(function* () {
		const repositories = yield* RepositoryService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()

		switch (options.subcommand) {
			case "add": {
				const [alias, remote] = options.args
				if (!alias || !remote) {
					return yield* Effect.fail(
						new Error("Usage: agency repo add <alias> <remote>"),
					)
				}
				yield* repositories.add(alias, remote, cwd)
				log(`Added repository '${alias}'`)
				return
			}

			case "link": {
				const [alias, path] = options.args
				if (!alias || !path) {
					return yield* Effect.fail(
						new Error("Usage: agency repo link <alias> <path>"),
					)
				}
				yield* repositories.link(alias, path, cwd)
				log(`Linked repository '${alias}'`)
				return
			}

			case "list": {
				const items = yield* repositories.list(cwd)
				if (options.json) {
					log(JSON.stringify(items, null, 2))
					return
				}
				for (const item of items) {
					const detail = item.target ?? item.remote ?? item.path
					log(`${item.alias}\t${item.kind}\t${detail}`)
				}
				return
			}

			default:
				return yield* Effect.fail(
					new Error(
						"Subcommand is required. Available subcommands: add, link, list",
					),
				)
		}
	})

export const help = `
Usage: agency repo <subcommand>

Subcommands:
  add <alias> <remote>  Create a bare clone
  link <alias> <path>   Link an existing Git repository
  list                  List repository aliases

Options:
  --json                Output repository aliases as JSON
`
