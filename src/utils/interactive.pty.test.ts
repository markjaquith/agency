import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "../test-utils"

const projectRoot = join(import.meta.dir, "../..")
const cliPath = join(projectRoot, "cli.ts")
const tempDirs: string[] = []

afterEach(() => Promise.all(tempDirs.splice(0).map(cleanupTempDir)))

const modes = (terminal: Bun.Terminal) => ({
	input: terminal.inputFlags,
	output: terminal.outputFlags,
	local: terminal.localFlags,
	control: terminal.controlFlags,
})

const waitFor = async (condition: () => boolean, output: () => string) => {
	const deadline = Date.now() + 8_000
	while (!condition()) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for terminal output:\n${output()}`)
		}
		await Bun.sleep(10)
	}
}

const waitForExit = (subprocess: Bun.Subprocess, output: () => string) =>
	new Promise<number>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`Timed out waiting for CLI exit:\n${output()}`))
		}, 8_000)
		subprocess.exited.then(
			(exitCode) => {
				clearTimeout(timeout)
				resolve(exitCode)
			},
			(error) => {
				clearTimeout(timeout)
				reject(error)
			},
		)
	})

const createWorkbase = async () => {
	const root = await createTempDir()
	tempDirs.push(root)
	const initialized = Bun.spawnSync(
		[process.execPath, cliPath, "init", root, "--silent"],
		{ stdout: "pipe", stderr: "pipe" },
	)
	if (initialized.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(initialized.stderr))
	}
	return root
}

const runPrompt = async (
	drive: (terminal: Bun.Terminal, output: () => string) => Promise<void>,
) => {
	const root = await createWorkbase()
	const decoder = new TextDecoder()
	let output = ""
	const terminal = new Bun.Terminal({
		cols: 80,
		rows: 24,
		data: (_terminal, bytes) => {
			output += decoder.decode(bytes, { stream: true })
		},
	})
	const initialModes = modes(terminal)
	const subprocess = Bun.spawn([process.execPath, cliPath, "task", "new"], {
		cwd: root,
		env: { ...process.env, TERM: "xterm-256color" },
		terminal,
	})

	try {
		await waitFor(
			() => output.includes("Task ID:"),
			() => output,
		)
		const activeModes = modes(terminal)
		expect(activeModes).not.toEqual(initialModes)
		await drive(terminal, () => output)
		const exitCode = await waitForExit(subprocess, () => output)
		output += decoder.decode()
		expect(exitCode).toBe(1)
		expect(modes(terminal)).toEqual(initialModes)
		expect(output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(
			output.lastIndexOf("\x1b[?25l"),
		)
		expect(output.lastIndexOf("\x1b[?2004l")).toBeGreaterThan(
			output.lastIndexOf("\x1b[?2004h"),
		)
		return output
	} finally {
		if (subprocess.exitCode === null) {
			subprocess.kill("SIGKILL")
			await subprocess.exited
		}
		terminal.close()
	}
}

describe("interactive CLI terminal restoration", () => {
	test("persistent session cancels in-flight work and restores the terminal", async () => {
		const root = await createTempDir()
		tempDirs.push(root)
		const entry = join(root, "progress.ts")
		await Bun.write(
			entry,
			`
import { Effect } from ${JSON.stringify(join(projectRoot, "node_modules/effect"))}
import { openActSession, ActCancelled } from ${JSON.stringify(join(projectRoot, "src/commands/act-prompts.ts"))}
await Effect.runPromise(Effect.gen(function* () {
  const session = yield* Effect.acquireRelease(openActSession(), s => s.close())
  session.show("Working fixture")
  yield* Effect.raceFirst(Effect.never, session.cancelled)
}).pipe(Effect.scoped, Effect.catchAll(error => error instanceof ActCancelled ? Effect.void : Effect.fail(error))))
console.log("Operation cancelled")
`,
		)
		let output = ""
		const decoder = new TextDecoder()
		const terminal = new Bun.Terminal({
			cols: 80,
			rows: 24,
			data: (_terminal, bytes) => {
				output += decoder.decode(bytes, { stream: true })
			},
		})
		const initialModes = modes(terminal)
		const subprocess = Bun.spawn([process.execPath, entry], {
			env: { ...process.env, TERM: "xterm-256color" },
			terminal,
		})
		try {
			await waitFor(
				() => output.includes("Working fixture"),
				() => output,
			)
			terminal.write("\x03")
			expect(await waitForExit(subprocess, () => output)).toBe(0)
			expect(modes(terminal)).toEqual(initialModes)
			expect(output.indexOf("Operation cancelled")).toBeGreaterThan(
				output.indexOf("\x1b[?1049l"),
			)
		} finally {
			if (subprocess.exitCode === null) {
				subprocess.kill("SIGKILL")
				await subprocess.exited
			}
			terminal.close()
		}
	}, 12_000)

	for (const finish of ["\r", "\x1b"]) {
		test(`act preserves completed creation in its recap after ${finish === "\r" ? "Finish" : "cancellation"}`, async () => {
			const root = await createWorkbase()
			const source = join(root, "source")
			for (const command of [
				["git", "init", "-b", "main", source],
				[
					"git",
					"-C",
					source,
					"remote",
					"add",
					"origin",
					"https://example.com/demo.git",
				],
				[process.execPath, cliPath, "repo", "link", "demo", source, "--silent"],
			]) {
				const result = Bun.spawnSync(command, {
					cwd: root,
					stdout: "pipe",
					stderr: "pipe",
				})
				if (result.exitCode !== 0)
					throw new Error(new TextDecoder().decode(result.stderr))
			}
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
			const subprocess = Bun.spawn(
				[process.execPath, cliPath, "act", "--action", "task-create"],
				{
					cwd: root,
					env: { ...process.env, TERM: "xterm-256color" },
					terminal,
				},
			)
			const wait = (text: string) =>
				waitFor(
					() => output.includes(text),
					() => output,
				)
			try {
				await wait("Outcome:")
				terminal.write("Persistent recap\r")
				await wait("persistent-recap")
				terminal.write("\r")
				await wait("main")
				terminal.write("\r")
				await wait("Work on the new item now")
				expect(output).not.toContain("\x1b[?1049l")
				terminal.write(finish)
				expect(await waitForExit(subprocess, () => output)).toBe(0)
				expect(modes(terminal)).toEqual(initialModes)
				const recap = output.slice(output.lastIndexOf("\x1b[?1049l"))
				expect(recap).toContain("󰄬  Create a standard task")
				expect(recap).toContain("Item: persistent-recap")
				expect(recap).not.toContain("Work handoff completed")
				expect(
					await Bun.file(join(root, "tasks/persistent-recap/TASK.md")).text(),
				).toContain("status: open")
				expect(output.match(/\x1b\[\?1049h/g)?.length).toBe(1)
				expect(output.match(/\x1b\[\?1049l/g)?.length).toBe(1)
			} finally {
				if (subprocess.exitCode === null) {
					subprocess.kill("SIGKILL")
					await subprocess.exited
				}
				terminal.close()
			}
		}, 15_000)
	}

	for (const outcome of ["preview", "cancel", "invalid"] as const) {
		test(`act keeps one renderer through selection and text input (${outcome})`, async () => {
			const root = await createWorkbase()
			let output = ""
			const decoder = new TextDecoder()
			const terminal = new Bun.Terminal({
				cols: 90,
				rows: 24,
				data: (_terminal, bytes) => {
					output += decoder.decode(bytes, { stream: true })
				},
			})
			const initialModes = modes(terminal)
			const subprocess = Bun.spawn(
				[process.execPath, cliPath, "act", "--dry-run"],
				{
					cwd: root,
					env: { ...process.env, TERM: "xterm-256color" },
					terminal,
				},
			)
			const wait = (text: string) =>
				waitFor(
					() => output.includes(text),
					() => output,
				)
			try {
				await wait("Your mission:")
				terminal.write("Add a repository")
				await Bun.sleep(50)
				terminal.write("\r")
				await wait("Link a local repository")
				terminal.write("\r")
				await wait("Repository alias:")
				expect(output.match(/\x1b\[\?1049h/g)?.length).toBe(1)
				expect(output).not.toContain("\x1b[?1049l")
				terminal.resize(60, 15)
				terminal.write(
					outcome === "cancel"
						? "\x03"
						: outcome === "invalid"
							? "\r"
							: "demo\r",
				)
				if (outcome === "preview") {
					await wait("URL:")
					terminal.write("https://example.com/demo.git\r")
				}
				expect(await waitForExit(subprocess, () => output)).toBe(
					outcome === "invalid" ? 1 : 0,
				)
				expect(modes(terminal)).toEqual(initialModes)
				expect(output.match(/\x1b\[\?1049h/g)?.length).toBe(1)
				expect(output.match(/\x1b\[\?1049l/g)?.length).toBe(1)
				if (outcome === "preview") {
					expect(
						output.indexOf(
							"Preview: agency repo add demo https://example.com/demo.git",
						),
					).toBeGreaterThan(output.indexOf("\x1b[?1049l"))
				} else if (outcome === "invalid")
					expect(output).toContain("Repository alias is required")
			} finally {
				if (subprocess.exitCode === null) {
					subprocess.kill("SIGKILL")
					await subprocess.exited
				}
				terminal.close()
			}
		}, 15_000)
	}

	test("restores terminal state after submission, resize, and escape", async () => {
		const output = await runPrompt(async (terminal, currentOutput) => {
			terminal.resize(30, 8)
			terminal.write("pty-contract\r")
			await waitFor(
				() => currentOutput().includes("Ticket URL (optional):"),
				currentOutput,
			)
			terminal.write("\x1b")
		})

		expect(output).toContain("Failed to read task input")
	}, 12_000)

	test("restores terminal state after ctrl-c", async () => {
		const output = await runPrompt(async (terminal) => {
			terminal.write("\x03")
		})

		expect(output).toContain("Failed to read task input")
	}, 12_000)
})
