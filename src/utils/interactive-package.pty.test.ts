import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { copyFile, mkdir, symlink } from "node:fs/promises"
import { dirname, join } from "node:path"
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
	// Pack an isolated copy: the pack hooks write and remove compiled views,
	// which must never race other tests reading the checkout. npm bundles
	// dependencies only from real files, so copy those a read-only dry run lists.
	const pkg = join(root, "pkg")
	const bundled = (
		JSON.parse(
			run(
				["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
				projectRoot,
			),
		) as { files: { path: string }[] }[]
	)[0]!.files
		.map((file) => file.path)
		.filter((path) => path.startsWith("node_modules/"))
	const files = [
		...run(["git", "ls-files", "-co", "--exclude-standard", "-z"], projectRoot)
			.split("\0")
			.filter(Boolean),
		...bundled,
	]
	for (const file of files) {
		const source = join(projectRoot, file)
		if (!(await Bun.file(source).exists())) continue
		await mkdir(dirname(join(pkg, file)), { recursive: true })
		await copyFile(source, join(pkg, file))
	}
	const filename = run(
		["npm", "pack", "--pack-destination", root, "--silent"],
		pkg,
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
	expect(
		await Bun.file(join(installed, "src/utils/supervise-tab.js")).exists(),
	).toBe(true)
	// Keep tarball-bundled dependencies intact and supply the remaining runtime
	// dependencies from the parent scope without requiring a network install.
	const manifest = await Bun.file(join(projectRoot, "package.json")).json()
	for (const name of Object.keys(manifest.dependencies)) {
		const destination = join(root, "node_modules", name)
		await mkdir(dirname(destination), { recursive: true })
		await symlink(join(projectRoot, "node_modules", name), destination)
	}
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
		// Never reach the live Herdr session or the user's registered workbases.
		env: {
			...Object.fromEntries(
				Object.entries(globalThis.process.env).filter(
					([name]) => !name.startsWith("HERDR_"),
				),
			),
			TERM: "xterm-256color",
			PATH: "/usr/bin:/bin",
			XDG_CONFIG_HOME: join(workbase, ".test-config"),
			AGENCY_STATE_DIR: join(workbase, ".test-state"),
		},
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
				await wait("Manage repositories")
				terminal.write("no-matching-action")
				await wait("No matches")
				terminal.write("\x1b")
				await wait("Create work")
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
