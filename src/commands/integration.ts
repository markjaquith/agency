import { Effect } from "effect"
import { relative } from "node:path"
import type { BaseCommandOptions } from "../utils/command"
import { IntegrationService } from "../services/IntegrationService"
import { createLoggers } from "../utils/effect"

interface IntegrationOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly json?: boolean
}

interface IntegrationResult {
	readonly root: string
	readonly files: readonly {
		readonly name: "agents" | "opencode"
		readonly path: string
		readonly state: string
		readonly diagnostic: string
		readonly remediation: string | null
		readonly changed?: boolean
	}[]
}

const integrationNames = {
	agents: "Agent instructions",
	opencode: "OpenCode config",
} as const

const logHumanResult = (
	log: (message: string) => void,
	subcommand: "status" | "sync",
	result: IntegrationResult,
) => {
	log(`Integration ${subcommand}: ${result.root}`)
	for (const file of result.files) {
		log("")
		log(
			`${integrationNames[file.name]}: ${file.changed ? "synced" : file.state}`,
		)
		log(`  Path: ${relative(result.root, file.path)}`)
		log(`  ${file.diagnostic}`)
		if (file.remediation) log(`  Action: ${file.remediation}`)
	}
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
				logHumanResult(log, "status", result)
				return
			}

			case "sync": {
				const result = yield* service.sync(cwd)
				if (options.json) {
					log(JSON.stringify(result, null, 2))
					return
				}
				logHumanResult(log, "sync", result)
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
launches load the managed file at runtime to provide whole-workbase read
access without changing Agency write authority.

Subcommands:
  status  Report file state, access diagnostics, and safe remediation
  sync    Create or update checksum-safe managed files

Options:
  --json  Output results as JSON
`
