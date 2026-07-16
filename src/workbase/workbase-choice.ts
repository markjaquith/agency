import { Effect } from "effect"

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
