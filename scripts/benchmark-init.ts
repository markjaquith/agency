import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sampleCount = 5
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(projectRoot, "cli.ts")

const median = (samples: readonly number[]) =>
	[...samples].sort((left, right) => left - right)[
		Math.floor(samples.length / 2)
	]!

const runInit = async (root: string) => {
	const start = performance.now()
	const child = Bun.spawn(
		[process.execPath, "--compile", cliPath, "init", root, "--silent"],
		{ stdout: "pipe", stderr: "pipe" },
	)
	await child.exited
	if (child.exitCode !== 0) {
		throw new Error((await new Response(child.stderr).text()).trim())
	}
	return performance.now() - start
}

const measure = async (large: boolean) => {
	const samples: number[] = []
	for (let index = 0; index < sampleCount; index += 1) {
		const parent = await mkdtemp(join(tmpdir(), "agency-init-benchmark-"))
		const root = join(parent, "workbase")
		try {
			if (large) {
				await mkdir(root)
				await Promise.all(
					Array.from({ length: 500 }, (_, entry) =>
						Bun.write(join(root, `unrelated-${entry}.txt`), "benchmark\n"),
					),
				)
			}
			samples.push(await runInit(root))
		} finally {
			await rm(parent, { recursive: true, force: true })
		}
	}
	return {
		medianMs: Math.round(median(samples)),
		samplesMs: samples.map(Math.round),
	}
}

console.log(
	JSON.stringify(
		{
			sampleCount,
			coldSmall: await measure(false),
			warmLarge: await measure(true),
		},
		null,
		2,
	),
)
