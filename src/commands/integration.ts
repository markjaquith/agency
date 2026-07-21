import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { IntegrationService } from "../services/IntegrationService"
import { createLoggers } from "../utils/effect"

interface IntegrationOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly json?: boolean
}

export const integration = (options: IntegrationOptions) =>
	Effect.gen(function* () {
		const service = yield* IntegrationService
		const { log } = createLoggers(options)
		const cwd = options.cwd ?? process.cwd()

		switch (options.subcommand) {
			case "status": {
				const result = yield* service.status(cwd)
				if (options.json) {
					log(JSON.stringify(result, null, 2))
					return
				}
				for (const file of result.files) {
					log(`${file.name}\t${file.state}\t${file.path}\t${file.diagnostic}`)
					if (file.remediation) log(`  Remediation: ${file.remediation}`)
				}
				return
			}

			case "sync": {
				const result = yield* service.sync(cwd)
				if (options.json) {
					log(JSON.stringify(result, null, 2))
					return
				}
				for (const file of result.files) {
					log(
						`${file.name}\t${file.changed ? "synced" : file.state}\t${file.path}\t${file.diagnostic}`,
					)
					if (file.remediation) log(`  Remediation: ${file.remediation}`)
				}
				return
			}

			default:
				return yield* Effect.fail(
					new Error("Subcommand is required. Available: status, sync"),
				)
		}
	})

export const help = `
Usage: agency integration <subcommand>

Inspect or explicitly synchronize managed agent integration files. OpenCode
launches load the managed instructions and project config at runtime, and expose
the managed /agency command, without changing Agency write authority.

Subcommands:
  status  Report file state, access diagnostics, and safe remediation
  sync    Create or update checksum-safe managed files

Options:
  --json  Output results as JSON
`
