import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "../test-utils"

const projectRoot = join(import.meta.dir, "../..")
const effectEntry = Bun.resolveSync("effect", projectRoot)
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

/**
 * A terminal environment that can never reach the live Herdr session or the
 * user's registered workbases: the Supervise tab sees only this test's state.
 */
const isolatedEnv = (extra: Record<string, string> = {}) => {
	const env: Record<string, string | undefined> = {
		...process.env,
		TERM: "xterm-256color",
		PATH: "/usr/bin:/bin",
		XDG_CONFIG_HOME: join(isolatedHome, "config"),
		AGENCY_STATE_DIR: join(isolatedHome, "state"),
		...extra,
	}
	for (const name of Object.keys(env))
		if (name.startsWith("HERDR_") && !(name in extra)) delete env[name]
	return env
}
const isolatedHome = await createTempDir()
afterAll(() => cleanupTempDir(isolatedHome))

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
		env: isolatedEnv(),
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
	test("bare agency exits when its renderer is destroyed by SIGTERM", async () => {
		const root = await createWorkbase()
		let output = ""
		const decoder = new TextDecoder()
		const terminal = new Bun.Terminal({
			cols: 80,
			rows: 24,
			data: (_, bytes) => {
				output += decoder.decode(bytes, { stream: true })
			},
		})
		const initialModes = modes(terminal)
		const subprocess = Bun.spawn([process.execPath, cliPath], {
			cwd: root,
			env: isolatedEnv(),
			terminal,
		})
		try {
			await waitFor(
				() => output.includes("No tasks or phases yet"),
				() => output,
			)
			subprocess.kill("SIGTERM")
			expect(await waitForExit(subprocess, () => output)).toBe(0)
			expect(modes(terminal)).toEqual(initialModes)
			expect(output.match(/\x1b\[\?1049h/g)).toHaveLength(1)
			expect(output.match(/\x1b\[\?1049l/g)).toHaveLength(1)
		} finally {
			if (subprocess.exitCode === null) {
				subprocess.kill("SIGKILL")
				await subprocess.exited
			}
			terminal.close()
		}
	}, 12_000)

	for (const signal of ["SIGTERM", "SIGHUP"] as const) {
		test(`supervise restores the terminal and exits cleanly on ${signal}`, async () => {
			const root = await createWorkbase()
			const home = await createTempDir()
			tempDirs.push(home)
			let output = ""
			const decoder = new TextDecoder()
			const terminal = new Bun.Terminal({
				cols: 100,
				rows: 24,
				data: (_, bytes) => {
					output += decoder.decode(bytes, { stream: true })
				},
			})
			const initialModes = modes(terminal)
			const subprocess = Bun.spawn([process.execPath, cliPath, "supervise"], {
				cwd: root,
				env: {
					TERM: "xterm-256color",
					HOME: home,
					XDG_CONFIG_HOME: join(home, "config"),
					AGENCY_STATE_DIR: join(home, "state"),
					// No runtime: keep the real Herdr session out of the test.
					PATH: "/usr/bin:/bin",
				},
				terminal,
			})
			try {
				// The Supervise tab's footer is showing.
				await waitFor(
					() => output.includes("e prompt"),
					() => output,
				)
				subprocess.kill(signal)
				expect(await waitForExit(subprocess, () => output)).toBe(0)
				expect(modes(terminal)).toEqual(initialModes)
				expect(output.match(/\x1b\[\?1049l/g)?.length).toBeGreaterThan(0)
			} finally {
				if (subprocess.exitCode === null) {
					subprocess.kill("SIGKILL")
					await subprocess.exited
				}
				terminal.close()
			}
		}, 12_000)
	}

	test("Work waits for a running Supervise action before replacing the TUI", async () => {
		const root = await realpath(await createTempDir())
		tempDirs.push(root)
		const source = join(root, "source")
		const marker = join(root, "focus-finished")
		// A fake Herdr whose focus takes a while, then leaves a marker.
		const herdr = join(root, "fake-herdr.sh")
		await Bun.write(
			herdr,
			`#!/bin/sh
if [ "$1 $2" = "api snapshot" ]; then
cat <<'JSON'
${JSON.stringify({
	id: "cli:api:snapshot",
	result: {
		snapshot: {
			workspaces: [{ workspace_id: "w1" }],
			tabs: [{ tab_id: "w1:t7", workspace_id: "w1" }],
			panes: [
				{
					pane_id: "w1:p7",
					tab_id: "w1:t7",
					workspace_id: "w1",
					agent: "opencode",
					agent_status: "idle",
					cwd: source,
				},
			],
		},
	},
})}
JSON
exit 0
fi
sleep 1.5
touch ${JSON.stringify(marker)}
exit 1
`,
		)
		const env = isolatedEnv({
			HERDR_ENV: "1",
			HERDR_BIN_PATH: herdr,
			HERDR_SOCKET_PATH: join(root, "missing.sock"),
		})
		for (const command of [
			["chmod", "+x", herdr],
			[process.execPath, cliPath, "init", root, "--silent"],
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
			[
				process.execPath,
				cliPath,
				"task",
				"create",
				"alpha",
				"--repo",
				"demo",
				"--base",
				"main",
				"--description",
				"First item",
				"--silent",
			],
		]) {
			const result = Bun.spawnSync(command, {
				cwd: root,
				env,
				stdout: "pipe",
				stderr: "pipe",
			})
			if (result.exitCode !== 0)
				throw new Error(new TextDecoder().decode(result.stderr))
		}
		const entry = join(root, "work-fixture.ts")
		await Bun.write(
			entry,
			`
import { Effect } from ${JSON.stringify(effectEntry)}
import { existsSync } from "node:fs"
import { runTestEffect } from ${JSON.stringify(join(projectRoot, "src/test-utils.ts"))}
import { act } from ${JSON.stringify(join(projectRoot, "src/commands/act.ts"))}
import { RuntimeService } from ${JSON.stringify(join(projectRoot, "src/services/RuntimeService.ts"))}
// The real runtime service, so Supervise sees the fake Herdr.
await runTestEffect(act({ cwd: ${JSON.stringify(root)}, inputAllowed: true, tab: "supervise" }, undefined, () => Effect.sync(() => console.log(existsSync(${JSON.stringify(marker)}) ? "WORK_AFTER_ACTION" : "WORK_BEFORE_ACTION"))).pipe(Effect.provide(RuntimeService.layer)))
`,
		)
		let output = ""
		const decoder = new TextDecoder()
		const terminal = new Bun.Terminal({
			cols: 120,
			rows: 30,
			data: (_, bytes) => {
				output += decoder.decode(bytes, { stream: true })
			},
		})
		const subprocess = Bun.spawn([process.execPath, entry], {
			cwd: root,
			env,
			terminal,
		})
		const wait = (text: string, from = 0) =>
			waitFor(
				() => output.includes(text, from),
				() => output,
			)
		try {
			await wait("Focus pane w1:p7")
			// Focus runs for a while; leave for Workstream and start Work meanwhile.
			terminal.write("f")
			await wait("working…")
			terminal.write("\t")
			await wait("alpha")
			terminal.write("\r")
			await wait("Act on task alpha")
			terminal.write("Work on this item")
			await Bun.sleep(50)
			terminal.write("\r")
			await wait("WORK_")
			expect(output).toContain("WORK_AFTER_ACTION")
			expect(output).not.toContain("WORK_BEFORE_ACTION")
			terminal.write("\x03")
			expect(await waitForExit(subprocess, () => output)).toBe(0)
		} finally {
			if (subprocess.exitCode === null) {
				subprocess.kill("SIGKILL")
				await subprocess.exited
			}
			terminal.close()
		}
	}, 30_000)

	test("supervise opens outside every workbase with no default and offers registered workbases", async () => {
		const home = await realpath(await createTempDir())
		tempDirs.push(home)
		const root = join(home, "registered")
		const outside = join(home, "elsewhere")
		const env = isolatedEnv({
			XDG_CONFIG_HOME: join(home, "config"),
			AGENCY_STATE_DIR: join(home, "state"),
		})
		for (const command of [
			["mkdir", "-p", outside],
			[process.execPath, cliPath, "init", root, "--silent"],
			[process.execPath, cliPath, "workbase", "add", root, "--silent"],
			[process.execPath, cliPath, "workbase", "default", "--clear", "--silent"],
		]) {
			const result = Bun.spawnSync(command, {
				cwd: home,
				env,
				stdout: "pipe",
				stderr: "pipe",
			})
			if (result.exitCode !== 0)
				throw new Error(new TextDecoder().decode(result.stderr))
		}
		let output = ""
		const decoder = new TextDecoder()
		const terminal = new Bun.Terminal({
			cols: 120,
			rows: 24,
			data: (_, bytes) => {
				output += decoder.decode(bytes, { stream: true })
			},
		})
		const initialModes = modes(terminal)
		const subprocess = Bun.spawn([process.execPath, cliPath, "supervise"], {
			cwd: outside,
			env,
			terminal,
		})
		const wait = (text: string, from = 0) =>
			waitFor(
				() => output.includes(text, from),
				() => output,
			)
		try {
			await wait("e prompt")
			const beforeSwitch = output.length
			terminal.write("\t")
			await wait("No workbase here", beforeSwitch)
			await wait(root, beforeSwitch)
			const beforeChoose = output.length
			terminal.write("\r")
			await wait("No tasks or phases yet", beforeChoose)
			expect(subprocess.exitCode).toBeNull()
			terminal.write("\x03")
			expect(await waitForExit(subprocess, () => output)).toBe(0)
			expect(modes(terminal)).toEqual(initialModes)
		} finally {
			if (subprocess.exitCode === null) {
				subprocess.kill("SIGKILL")
				await subprocess.exited
			}
			terminal.close()
		}
	}, 20_000)

	test("supervise hands an Agency action to the act wizard, then previews, confirms, and runs it", async () => {
		// Pane paths must match the workbase's resolved root.
		const root = await realpath(await createTempDir())
		tempDirs.push(root)
		const source = join(root, "source")
		// A fake Herdr runtime with one agent pane outside any Agency item.
		const herdr = join(root, "fake-herdr.sh")
		await Bun.write(
			herdr,
			`#!/bin/sh
if [ "$1 $2" = "api snapshot" ]; then
cat <<'JSON'
${JSON.stringify({
	id: "cli:api:snapshot",
	result: {
		snapshot: {
			workspaces: [{ workspace_id: "w1", label: "Main", focused: true }],
			tabs: [{ tab_id: "w1:t7", workspace_id: "w1", label: "loose" }],
			panes: [
				{
					pane_id: "w1:p7",
					tab_id: "w1:t7",
					workspace_id: "w1",
					agent: "opencode",
					agent_session: { value: "ses_loose" },
					agent_status: "idle",
					cwd: source,
				},
			],
		},
	},
})}
JSON
exit 0
fi
echo '{"id":"cli","error":{"code":"unsupported","message":"fake"}}'
exit 1
`,
		)
		const env = isolatedEnv({
			HERDR_ENV: "1",
			HERDR_BIN_PATH: herdr,
			HERDR_SOCKET_PATH: join(root, "missing.sock"),
		})
		for (const command of [
			["chmod", "+x", herdr],
			[process.execPath, cliPath, "init", root, "--silent"],
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
				env,
				stdout: "pipe",
				stderr: "pipe",
			})
			if (result.exitCode !== 0)
				throw new Error(new TextDecoder().decode(result.stderr))
		}
		let output = ""
		const decoder = new TextDecoder()
		const terminal = new Bun.Terminal({
			cols: 120,
			rows: 30,
			data: (_, bytes) => {
				output += decoder.decode(bytes, { stream: true })
			},
		})
		const initialModes = modes(terminal)
		const subprocess = Bun.spawn([process.execPath, cliPath, "supervise"], {
			cwd: root,
			env,
			terminal,
		})
		const wait = (text: string, from = 0) =>
			waitFor(
				() => output.includes(text, from),
				() => output,
			)
		try {
			await wait("Adopt this session as a new task")
			const beforeEnter = output.length
			terminal.write("\r")
			// The act wizard collects the inputs inside the Supervise tab.
			await wait("Outcome:", beforeEnter)
			terminal.write("Adopted work\r")
			await wait("[adopted-work]", beforeEnter)
			terminal.write("\r")
			await wait("main]:", beforeEnter)
			terminal.write("\r")
			// The executor re-resolves, then previews exactly what will run.
			await wait("Will run:", beforeEnter)
			await wait("agency task create adopted-work", beforeEnter)
			await Bun.sleep(300)
			terminal.write("\r")
			await wait("✓ Adopt this session as a new task", beforeEnter)
			expect(
				await Bun.file(join(root, "tasks/adopted-work/TASK.md")).text(),
			).toContain("Adopted work")
			// Workstream reloads with the new task once it is shown.
			const beforeSwitch = output.length
			terminal.write("\t")
			await wait("adopted-work", beforeSwitch)
			expect(subprocess.exitCode).toBeNull()
			terminal.write("\x03")
			expect(await waitForExit(subprocess, () => output)).toBe(0)
			expect(modes(terminal)).toEqual(initialModes)
			expect(output.match(/\x1b\[\?1049h/g)).toHaveLength(1)
			expect(output.match(/\x1b\[\?1049l/g)).toHaveLength(1)
		} finally {
			if (subprocess.exitCode === null) {
				subprocess.kill("SIGKILL")
				await subprocess.exited
			}
			terminal.close()
		}
	}, 30_000)

	for (const signal of ["SIGTERM", "SIGHUP"] as const) {
		test(`act with Supervise running restores the terminal and exits cleanly on ${signal}`, async () => {
			const root = await createWorkbase()
			let output = ""
			const decoder = new TextDecoder()
			const terminal = new Bun.Terminal({
				cols: 100,
				rows: 24,
				data: (_, bytes) => {
					output += decoder.decode(bytes, { stream: true })
				},
			})
			const initialModes = modes(terminal)
			const subprocess = Bun.spawn([process.execPath, cliPath, "act"], {
				cwd: root,
				env: isolatedEnv(),
				terminal,
			})
			try {
				await waitFor(
					() => output.includes("No tasks or phases yet"),
					() => output,
				)
				// Shift-Tab reaches Supervise and starts its supervisor.
				terminal.write("\x1b[Z")
				await waitFor(
					() => output.includes("e prompt"),
					() => output,
				)
				subprocess.kill(signal)
				expect(await waitForExit(subprocess, () => output)).toBe(0)
				expect(modes(terminal)).toEqual(initialModes)
				expect(output.match(/\x1b\[\?1049l/g)?.length).toBeGreaterThan(0)
			} finally {
				if (subprocess.exitCode === null) {
					subprocess.kill("SIGKILL")
					await subprocess.exited
				}
				terminal.close()
			}
		}, 12_000)
	}

	for (const shutdown of ["ctrl-c", "SIGTERM"] as const) {
		test(`persistent session cancels in-flight work and restores the terminal (${shutdown})`, async () => {
			const root = await createTempDir()
			tempDirs.push(root)
			const entry = join(root, "progress.ts")
			await Bun.write(
				entry,
				`
import { Effect } from ${JSON.stringify(effectEntry)}
import { openActSession, ActCancelled } from ${JSON.stringify(join(projectRoot, "src/commands/act-prompts.ts"))}
await Effect.runPromise(Effect.gen(function* () {
  const session = yield* Effect.acquireRelease(openActSession(), s => s.close())
  session.show("Working fixture")
  yield* Effect.raceFirst(Effect.never, session.cancelled)
}).pipe(Effect.scoped, Effect.catch(error => error instanceof ActCancelled ? Effect.void : Effect.fail(error))))
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
				env: isolatedEnv(),
				terminal,
			})
			try {
				await waitFor(
					() => output.includes("Working fixture"),
					() => output,
				)
				if (shutdown === "SIGTERM") subprocess.kill("SIGTERM")
				else terminal.write("\x03")
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
	}

	for (const finish of ["\r", "\x1b", "work"]) {
		test(`act preserves completed creation in its recap after ${finish === "\r" ? "Finish" : finish === "work" ? "worker return" : "cancellation"}`, async () => {
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
			const entry = join(root, "worker-fixture.ts")
			if (finish === "work")
				await Bun.write(
					entry,
					`
import { Effect } from ${JSON.stringify(effectEntry)}
import { runTestEffect } from ${JSON.stringify(join(projectRoot, "src/test-utils.ts"))}
import { act } from ${JSON.stringify(join(projectRoot, "src/commands/act.ts"))}
await runTestEffect(act({ cwd: ${JSON.stringify(root)}, action: "task-create", inputAllowed: true }, undefined, () => Effect.sync(() => console.log("WORKER_RETURNED"))))
`,
				)
			const subprocess = Bun.spawn(
				finish === "work"
					? [process.execPath, entry]
					: [
							process.execPath,
							cliPath,
							...(finish === "\r" ? [] : ["act", "--action", "task-create"]),
						],
				{
					cwd: root,
					env: isolatedEnv(),
					terminal,
				},
			)
			const wait = (text: string) =>
				waitFor(
					() => output.includes(text),
					() => output,
				)
			try {
				if (finish === "\r") {
					await wait("No tasks or phases yet")
					terminal.write("\t")
					await wait("Create work")
					terminal.write("\r")
					await wait("standard")
					terminal.write("\r")
				}
				await wait("Outcome:")
				terminal.write("Persistent recap\r")
				await wait("persistent-recap")
				terminal.write("\r")
				await wait("main")
				terminal.write("\r")
				await wait("Work on the new item now")
				expect(output).not.toContain("\x1b[?1049l")
				const beforeFinish = output.length
				terminal.write(finish === "work" ? "\x1b[B\r" : finish)
				await waitFor(
					() =>
						output
							.slice(beforeFinish)
							.includes(finish === "\r" ? "Create work" : "󰄱  open"),
					() => output,
				)
				expect(subprocess.exitCode).toBeNull()
				if (finish === "work")
					expect(output.indexOf("WORKER_RETURNED")).toBeGreaterThan(
						output.indexOf("\x1b[?1049l"),
					)
				else expect(output).not.toContain("\x1b[?1049l")
				if (finish === "\r") {
					const beforeSwitch = output.length
					terminal.write("\x1b[Z")
					await waitFor(
						() => output.slice(beforeSwitch).includes("󰄱  open"),
						() => output,
					)
				}
				expect(output.slice(beforeFinish)).toContain("persistent-recap")
				if (finish === "\r") {
					terminal.write("\r")
					await wait("task persistent-recap")
					terminal.write("Complete")
					await Bun.sleep(50)
					terminal.write("\r")
					await wait("outcome summary")
					const beforeCancel = output.length
					terminal.write("\x1b")
					await waitFor(
						() => output.slice(beforeCancel).includes("pull request"),
						() => output,
					)
					terminal.write("Drop")
					await Bun.sleep(50)
					terminal.write("\r")
					await wait("dropped")
					expect(subprocess.exitCode).toBeNull()
					expect(output).not.toContain("\x1b[?1049l")
				}
				if (finish === "\r") {
					terminal.write("\x1b")
					await Bun.sleep(100)
					expect(subprocess.exitCode).toBeNull()
					expect(output).not.toContain("\x1b[?1049l")
				}
				terminal.write("\x03")
				expect(await waitForExit(subprocess, () => output)).toBe(0)
				expect(modes(terminal)).toEqual(initialModes)
				const recap = output.slice(output.lastIndexOf("\x1b[?1049l"))
				expect(recap).toContain("󰄬  Create a standard task")
				expect(recap).toContain("Item: persistent-recap")
				if (finish === "work") expect(recap).toContain("Work handoff completed")
				else expect(recap).not.toContain("Work handoff completed")
				expect(
					await Bun.file(join(root, "tasks/persistent-recap/TASK.md")).text(),
				).toContain(finish === "\r" ? "status: dropped" : "status: open")
				expect(output.match(/\x1b\[\?1049h/g)?.length).toBe(
					finish === "work" ? 2 : 1,
				)
				expect(output.match(/\x1b\[\?1049l/g)?.length).toBe(
					finish === "work" ? 2 : 1,
				)
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
					env: isolatedEnv(),
					terminal,
				},
			)
			const wait = (text: string) =>
				waitFor(
					() => output.includes(text),
					() => output,
				)
			try {
				await wait("No tasks or phases yet")
				terminal.write("\t")
				await wait("Manage repositories")
				terminal.write("Manage repositories")
				await Bun.sleep(50)
				terminal.write("\r")
				await wait("Link a local repository")
				terminal.write("\r")
				await wait("enter submit | shift-enter newline")
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
					const beforeBack = output.length
					terminal.write("\x1b")
					await waitFor(
						() => output.slice(beforeBack).includes("alias:"),
						() => output,
					)
					const beforeForward = output.length
					terminal.write("demo\r")
					await waitFor(
						() => output.slice(beforeForward).includes("URL:"),
						() => output,
					)
					terminal.write("https://example.com/demo.git\r")
				}
				if (outcome !== "cancel") {
					await wait(outcome === "preview" ? "Preview:" : "is required")
					if (outcome === "invalid") {
						terminal.write("recovered\r")
						await wait("URL:")
						terminal.write("https://example.com/recovered.git\r")
						await wait("Preview:")
					}
					const afterPreview = output.lastIndexOf("Preview:")
					await waitFor(
						() => output.slice(afterPreview).includes("Create work"),
						() => output,
					)
					expect(subprocess.exitCode).toBeNull()
					// Escape never quits the front screen; Ctrl-C does.
					terminal.write("\x1b")
					await Bun.sleep(100)
					expect(subprocess.exitCode).toBeNull()
					terminal.write("\x03")
				}
				expect(await waitForExit(subprocess, () => output)).toBe(0)
				expect(modes(terminal)).toEqual(initialModes)
				expect(output.match(/\x1b\[\?1049h/g)?.length).toBe(1)
				expect(output.match(/\x1b\[\?1049l/g)?.length).toBe(1)
				if (outcome === "preview") {
					expect(
						output.lastIndexOf(
							"Preview: agency repo add demo https://example.com/demo.git",
						),
					).toBeGreaterThan(output.indexOf("\x1b[?1049l"))
				} else if (outcome === "invalid") {
					expect(output).toContain("Repository alias is required")
					expect(output).toContain(
						"agency repo add recovered https://example.com/recovered.git",
					)
				}
			} finally {
				if (subprocess.exitCode === null) {
					subprocess.kill("SIGKILL")
					await subprocess.exited
				}
				terminal.close()
			}
		}, 15_000)
	}

	test("act queues status changes in the background and rolls back failures", async () => {
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
			...[
				["alpha", "First item"],
				["beta", "Second item"],
				["gamma", "Third item"],
			].map(([id, description]) => [
				process.execPath,
				cliPath,
				"task",
				"create",
				id!,
				"--repo",
				"demo",
				"--base",
				"main",
				"--description",
				description!,
				"--silent",
			]),
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
		const subprocess = Bun.spawn([process.execPath, cliPath, "act"], {
			cwd: root,
			env: isolatedEnv(),
			terminal,
		})
		const wait = (text: string) =>
			waitFor(
				() => output.includes(text),
				() => output,
			)
		const choose = async (item: string, action: string) => {
			terminal.write(item)
			await Bun.sleep(50)
			terminal.write("\r")
			await wait(`Act on task ${item}`)
			terminal.write(action)
			await Bun.sleep(50)
			const beforeQueue = output.length
			terminal.write("\r")
			// Workstream returns without waiting for the queued action to run.
			await waitFor(
				() => output.slice(beforeQueue).includes("type to filter"),
				() => output,
			)
		}
		const taskFile = (id: string) => join(root, `tasks/${id}/TASK.md`)
		try {
			await wait("gamma")
			// The displayed revision becomes stale, so gamma's queued drop fails.
			const gamma = await Bun.file(taskFile("gamma")).text()
			await Bun.write(taskFile("gamma"), `${gamma}\nExternal edit.\n`)
			await choose("alpha", "Drop")
			await choose("alpha", "Reopen")
			await choose("beta", "Drop")
			await choose("gamma", "Drop")
			await wait("gamma failed — task gamma changed since it was chosen")
			expect(subprocess.exitCode).toBeNull()
			terminal.write("\x03")
			expect(await waitForExit(subprocess, () => output)).toBe(0)
			expect(modes(terminal)).toEqual(initialModes)
			const recap = output.slice(output.lastIndexOf("\x1b[?1049l"))
			for (const line of [
				"󰄬  Drop — alpha",
				"󰄬  Reopen — alpha",
				"󰄬  Drop — beta",
				"󰅖  Drop — gamma failed",
			])
				expect(recap).toContain(line)
			expect(await Bun.file(taskFile("alpha")).text()).toContain("status: open")
			expect(await Bun.file(taskFile("beta")).text()).toContain(
				"status: dropped",
			)
			expect(await Bun.file(taskFile("gamma")).text()).toContain("status: open")
		} finally {
			if (subprocess.exitCode === null) {
				subprocess.kill("SIGKILL")
				await subprocess.exited
			}
			terminal.close()
		}
	}, 20_000)

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
