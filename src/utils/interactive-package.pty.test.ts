import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "../test-utils"

const projectRoot = join(import.meta.dir, "../..")
let root: string
let cli: string
let workbase: string

const run = (command: string[], cwd: string) => {
	const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" })
	if (result.exitCode !== 0)
		throw new Error(new TextDecoder().decode(result.stderr))
	return new TextDecoder().decode(result.stdout).trim()
}

beforeAll(async () => {
	root = await createTempDir()
	const filename = run(
		["npm", "pack", "--pack-destination", root, "--silent"],
		projectRoot,
	)
	const archive = join(root, filename)
	// Exercise the actual published files beneath node_modules, without the
	// checkout's bunfig preload or a network install on every test run.
	const installed = join(root, "node_modules/@markjaquith/agency")
	await mkdir(installed, { recursive: true })
	run(["tar", "-xzf", archive, "--strip-components=1", "-C", installed], root)
	expect(
		await Bun.file(join(installed, "src/utils/interactive.js")).exists(),
	).toBe(true)
	expect(
		await Bun.file(join(installed, "src/utils/interactive.tsx")).exists(),
	).toBe(false)
	await symlink(
		join(projectRoot, "node_modules"),
		join(installed, "node_modules"),
	)
	cli = join(installed, "cli.ts")
	workbase = join(root, "workbase")
	run([process.execPath, cli, "init", workbase, "--silent"], root)
}, 30_000)

afterAll(async () => {
	if (root) await cleanupTempDir(root)
})

const modes = (terminal: Bun.Terminal) => ({
	input: terminal.inputFlags,
	output: terminal.outputFlags,
	local: terminal.localFlags,
	control: terminal.controlFlags,
})

const withTerminal = async (
	args: string[],
	drive: (
		terminal: Bun.Terminal,
		wait: (text: string) => Promise<void>,
	) => Promise<void>,
) => {
	let output = ""
	const decoder = new TextDecoder()
	const terminal = new Bun.Terminal({
		cols: 100,
		rows: 24,
		data: (_terminal, bytes) => {
			output += decoder.decode(bytes, { stream: true })
		},
	})
	const initialModes = modes(terminal)
	const process = Bun.spawn([globalThis.process.execPath, cli, ...args], {
		cwd: workbase,
		env: { ...globalThis.process.env, TERM: "xterm-256color" },
		terminal,
	})
	const waitUntil = async (ready: () => boolean) => {
		const deadline = Date.now() + 8_000
		while (!ready()) {
			if (Date.now() >= deadline)
				throw new Error(`Installed CLI did not respond:\n${output}`)
			await Bun.sleep(10)
		}
	}
	try {
		let cursor = 0
		await drive(terminal, async (text) => {
			await waitUntil(() => output.includes(text, cursor))
			cursor = output.indexOf(text, cursor) + text.length
		})
		await waitUntil(() => process.exitCode !== null)
		expect(await process.exited).toBe(0)
		expect(modes(terminal)).toEqual(initialModes)
		expect(output.match(/\x1b\[\?1049h/g)).toHaveLength(1)
		expect(output.match(/\x1b\[\?1049l/g)).toHaveLength(1)
		return output
	} finally {
		if (process.exitCode === null) {
			process.kill("SIGKILL")
			await process.exited
		}
		terminal.close()
	}
}

describe("published interactive CLI", () => {
	for (const args of [[], ["act"]]) {
		test(`agency ${args.join(" ")} advances beyond Preparing and handles input`, async () => {
			await withTerminal(args, async (terminal, wait) => {
				await wait("No tasks or phases yet")
				terminal.write("\t")
				await wait("Add a repository")
				terminal.write("no-matching-action")
				await wait("No matches")
				terminal.write("\x1b")
				await wait("Create a task")
				terminal.write("\x0e\x10")
				terminal.write("\r")
				await wait("standard")
				terminal.write("\x03")
			})
		}, 12_000)
	}

	test("reports invalid startup selections and returns to a usable menu", async () => {
		await withTerminal(
			["act", "--task", "missing-item"],
			async (terminal, wait) => {
				await wait("Selected work item 'task:missing-item' was not found")
				await wait("No tasks or phases yet")
				terminal.write("\x03")
			},
		)
	}, 12_000)
})
