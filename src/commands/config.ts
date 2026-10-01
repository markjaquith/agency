import { Effect } from "effect"
import { WorkbaseService } from "../services/WorkbaseService"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"

export const config = (
	options: BaseCommandOptions & { readonly args: readonly string[] },
) =>
	Effect.gen(function* () {
		const [setting, value] = options.args
		if (
			setting !== "auto-archive" ||
			(value !== undefined && value !== "on" && value !== "off")
		) {
			return yield* Effect.fail(
				new Error("Usage: agency config auto-archive [on|off]"),
			)
		}
		const workbase = yield* WorkbaseService
		const { log } = createLoggers(options)
		const result =
			value === undefined
				? yield* workbase.loadConfig(options.cwd).pipe(
						Effect.map(({ root, config }) => ({
							root,
							autoArchive: config.autoArchive ?? false,
						})),
					)
				: yield* workbase.setAutoArchive(value === "on", options.cwd)
		log(
			options.json
				? JSON.stringify(result, null, 2)
				: `Auto archive: ${result.autoArchive ? "on" : "off"}`,
		)
	})

export const help = `
Usage: agency config auto-archive [on|off] [--json]

Show, enable, or disable automatic archiving in this workbase.
Defaults to off. Enabling applies to future terminal transitions, not existing
terminal work. Archive safety checks are never bypassed.
`
