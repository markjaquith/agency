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
