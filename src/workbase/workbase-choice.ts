import { Effect } from "effect"
import { resolve } from "node:path"
import { WorkbaseService } from "../services/WorkbaseService"
import { choose } from "../utils/chooser"

export type PickWorkbase = (
	workbases: readonly string[],
	command?: readonly string[],
) => Effect.Effect<string | null, Error>

export const pickWorkbase: PickWorkbase = (workbases, command) =>
	choose(
		"Workbase",
		workbases.map((workbase, index) => ({
			key: String(index),
			label: workbase,
			value: workbase,
		})),
		command,
	)

export const resolveWorkbase = (
	startPath: string,
	pick: PickWorkbase = pickWorkbase,
	inputAllowed = true,
) =>
	Effect.gen(function* () {
		const workbase = yield* WorkbaseService

		return yield* workbase.discover(startPath).pipe(
			Effect.catchTag("WorkbaseNotFoundError", () =>
				Effect.gen(function* () {
					const defaultWorkbase = yield* workbase.getDefault()
					if (defaultWorkbase) return defaultWorkbase.path
					const registered = yield* workbase.listRegistered()
					if (registered.length === 0) {
						return yield* Effect.fail(
							new Error(
								`No Agency workbase found from ${resolve(startPath)}. Register one with 'agency workbase add <path>'.`,
							),
						)
					}
					if (!inputAllowed) {
						return yield* Effect.fail(
							new Error(
								"Workbase selection requires interactive input; provide an explicit path or run Agency from a workbase",
							),
						)
					}

					const selected = yield* pick(registered)
					return selected ? yield* workbase.discover(selected) : null
				}),
			),
		)
	})
