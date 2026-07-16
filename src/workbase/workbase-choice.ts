import { Effect } from "effect"
import { resolve } from "node:path"
import { FileSystemService } from "../services/FileSystemService"
import { WorkbaseService } from "../services/WorkbaseService"

export type PickWorkbase = (
	workbases: readonly string[],
) => Effect.Effect<string | null, Error>

export const pickWorkbase: PickWorkbase = (workbases) =>
	Effect.tryPromise({
		try: async () => {
			const input = workbases
				.map((workbase, index) => `${index}\t${workbase}`)
				.join("\n")
			const process = Bun.spawn(
				["fzf", "--delimiter=\t", "--with-nth=2..", "--prompt=Workbase> "],
				{ stdin: new Blob([input]), stdout: "pipe", stderr: "inherit" },
			)
			const [exitCode, output] = await Promise.all([
				process.exited,
				new Response(process.stdout).text(),
			])
			if (exitCode === 1 || exitCode === 130) return null
			if (exitCode !== 0) throw new Error(`fzf exited with code ${exitCode}`)
			const index = Number.parseInt(output.split("\t", 1)[0] ?? "", 10)
			return workbases[index] ?? null
		},
		catch: (cause) =>
			new Error("Failed to select a workbase with fzf", { cause }),
	})

export const resolveWorkbase = (
	startPath: string,
	log: (message: string) => void,
	pick: PickWorkbase = pickWorkbase,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService

		return yield* workbase.discover(startPath).pipe(
			Effect.catchTag("WorkbaseNotFoundError", () =>
				Effect.gen(function* () {
					const registered = yield* workbase.listRegistered()
					if (registered.length === 0) {
						return yield* Effect.fail(
							new Error(
								`No Agency workbase found from ${resolve(startPath)}. Register one with 'agency workbase add <path>'.`,
							),
						)
					}

					const fzf = yield* fs.runCommand(["which", "fzf"], {
						captureOutput: true,
					})
					if (fzf.exitCode !== 0) {
						for (const path of registered) log(path)
						return yield* Effect.fail(
							new Error(
								"fzf is required to select a workbase; install fzf or run Agency from a registered workbase",
							),
						)
					}

					const selected = yield* pick(registered)
					return selected ? yield* workbase.discover(selected) : null
				}),
			),
		)
	})
