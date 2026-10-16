import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
	cleanupTempDir,
	createFakeRuntimeProvider,
	createTempDir,
	fakeRuntimeService,
	runTestEffect,
	runtimePane,
} from "../test-utils"
import { RuntimeError, type RuntimeProvider } from "../workbase/runtime"
import {
	RuntimeBindingService,
	runtimeSummary,
	unitRuntimeView,
} from "./RuntimeBindingService"
import { RuntimeService } from "./RuntimeService"
import { FileSystemService } from "./FileSystemService"

let tempDir: string
let root: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
	tempDir = await createTempDir()
	root = join(tempDir, "workbase")
	await mkdir(root)
	env = { AGENCY_STATE_DIR: join(tempDir, "state") }
})

afterEach(async () => {
	await cleanupTempDir(tempDir)
})

const run = <A, E>(
	effect: Effect.Effect<A, E, any>,
	provider: RuntimeProvider | null = null,
) =>
	runTestEffect(
		effect.pipe(
			Effect.provideService(RuntimeService, fakeRuntimeService(provider)),
		),
	)

const herdr = (paneId: string) => ({
	HERDR_ENV: "1",
	HERDR_PANE_ID: paneId,
	HERDR_TAB_ID: "w1:t2",
	HERDR_WORKSPACE_ID: "w1",
})

const recordLaunch = (unit: string, launchEnv: NodeJS.ProcessEnv) =>
	Effect.flatMap(RuntimeBindingService, (service) =>
		service.recordLaunch(
			{
				root,
				unit,
				agent: "opencode2",
				agentSessionId: "ses_a",
				agencySessionId: "1-2",
			},
			launchEnv,
		),
	)

const launch = (unit = "execution-unit:task/alpha", paneId = "w1:p2") =>
	recordLaunch(unit, { ...env, ...herdr(paneId) })

const listBindings = () =>
	run(
		Effect.flatMap(RuntimeBindingService, (service) => service.list(root, env)),
	)

describe("RuntimeBindingService", () => {
	test("stores bindings under the XDG or home state directory by default", async () => {
		for (const [stateEnv, directory] of [
			[
				{ XDG_STATE_HOME: join(tempDir, "xdg") },
				join(tempDir, "xdg", "agency"),
			],
			[
				{ HOME: join(tempDir, "home") },
				join(tempDir, "home", ".local", "state", "agency"),
			],
		] as const) {
			env = stateEnv
			await run(launch())
			expect(await readdir(directory)).toEqual(["runtime-bindings"])
		}
	})

	test("records nothing outside a runtime, without runtime detection", async () => {
		const detection = runTestEffect(
			Effect.all([
				recordLaunch("execution-unit:task/alpha", env),
				recordLaunch("execution-unit:task/alpha", {
					...env,
					HERDR_PANE_ID: "w1:p2",
				}),
			]).pipe(
				Effect.provideService(RuntimeService, {
					provider: () => Effect.die("recording must not detect a runtime"),
				}),
			),
		)
		expect(await detection).toEqual([null, null])
		expect(await readdir(tempDir)).toEqual(["workbase"])
	})

	test("records inside Herdr without consulting the runtime binary", async () => {
		const recorded = await runTestEffect(
			launch().pipe(
				Effect.provideService(RuntimeService, {
					provider: () => Effect.die("recording must not detect a runtime"),
				}),
			),
		)
		expect(recorded?.paneId).toBe("w1:p2")
	})

	test("a newer launch in the same pane supersedes other units' bindings", async () => {
		await run(launch("execution-unit:task/alpha", "w1:p2"))
		await run(launch("execution-unit:task/gamma", "w1:p3"))
		await run(launch("execution-unit:task/beta", "w1:p2"))
		expect(
			(await listBindings()).map((item) => [item.unit, item.paneId]),
		).toEqual([
			["execution-unit:task/beta", "w1:p2"],
			["execution-unit:task/gamma", "w1:p3"],
		])
	})

	test("removes the temporary file when the atomic rename fails", async () => {
		const deleted: string[] = []
		const failing = Effect.gen(function* () {
			const fs = yield* FileSystemService
			return {
				...fs,
				moveDirectory: () => Effect.fail(new Error("rename failed")) as never,
				deleteFile: (path: string) => {
					deleted.push(path)
					return fs.deleteFile(path)
				},
			} satisfies FileSystemService["Service"]
		})
		const error = await runTestEffect(
			Effect.gen(function* () {
				const fs = yield* failing
				return yield* Effect.flip(
					launch().pipe(Effect.provideService(FileSystemService, fs)),
				)
			}),
		)
		expect(error).toBeInstanceOf(Error)
		expect(deleted).toHaveLength(1)
		expect(deleted[0]).toEndWith(".tmp")
		const directory = join(env.AGENCY_STATE_DIR!, "runtime-bindings")
		const [workbaseKey] = await readdir(directory)
		expect(await readdir(join(directory, workbaseKey!))).toEqual([])
	})

	test("records the current pane and lists bindings per workbase unit", async () => {
		const recorded = await run(launch())
		expect(recorded).toMatchObject({
			version: 1,
			unit: "execution-unit:task/alpha",
			runtime: "herdr",
			paneId: "w1:p2",
			tabId: "w1:t2",
			workspaceId: "w1",
			agent: "opencode2",
			agentSessionId: "ses_a",
			agencySessionId: "1-2",
		})
		expect(Number.isNaN(Date.parse(recorded!.boundAt))).toBe(false)
		await run(launch("execution-unit:phase/beta/build", "w1:p3"))
		// Relaunching replaces the unit's binding.
		await run(launch("execution-unit:task/alpha", "w9:p1"))

		const bindings = await listBindings()
		expect(bindings.map((item) => [item.unit, item.paneId])).toEqual([
			["execution-unit:phase/beta/build", "w1:p3"],
			["execution-unit:task/alpha", "w9:p1"],
		])

		const other = join(tempDir, "other")
		await mkdir(other)
		expect(
			await run(
				Effect.flatMap(RuntimeBindingService, (service) =>
					service.list(other, env),
				),
			),
		).toEqual([])
	})

	test("ignores corrupt binding files", async () => {
		const recorded = await run(launch())
		const directory = join(
			env.AGENCY_STATE_DIR!,
			"runtime-bindings",
			(await readdir(join(env.AGENCY_STATE_DIR!, "runtime-bindings")))[0]!,
		)
		await writeFile(join(directory, "broken.json"), "{not json")
		const bindings = await run(
			Effect.flatMap(RuntimeBindingService, (service) =>
				service.list(root, env),
			),
		)
		expect(bindings).toEqual([recorded!])
	})

	test("reconciles bindings and infers unbound panes against the live runtime", async () => {
		await run(launch())
		const provider = createFakeRuntimeProvider({
			panes: [
				runtimePane({ paneId: "w3:p1", agentSessionId: "ses_a" }),
				runtimePane({
					paneId: "w3:p2",
					foregroundCwd: join(root, "tasks", "beta", "code", "agency"),
				}),
				runtimePane({ paneId: "w3:p3", cwd: "/elsewhere" }),
			],
		})
		const units = [
			{ id: "execution-unit:task/alpha", taskId: "alpha", repo: "agency" },
			{ id: "execution-unit:task/beta", taskId: "beta", repo: "agency" },
		]
		const inspection = await run(
			Effect.flatMap(RuntimeBindingService, (service) =>
				service.inspect(root, units, env),
			),
			provider,
		)
		expect(inspection).toMatchObject({
			provider: "herdr",
			available: true,
			error: null,
		})
		expect(
			unitRuntimeView(inspection, "execution-unit:task/alpha"),
		).toMatchObject({
			binding: { state: "moved", record: { paneId: "w1:p2" } },
			inferred: [],
		})
		expect(
			unitRuntimeView(inspection, "execution-unit:task/beta"),
		).toMatchObject({
			binding: null,
			inferred: [{ matchedBy: "checkout", pane: { paneId: "w3:p2" } }],
		})
		expect(
			runtimeSummary(inspection, new Set(["execution-unit:task/beta"])),
		).toMatchObject({
			unmanaged: [{ paneId: "w3:p3" }],
			orphaned: [
				{ state: "moved", record: { unit: "execution-unit:task/alpha" } },
			],
		})
	})

	test("reports bindings as unknown when no runtime is available", async () => {
		await run(launch())
		const failing: RuntimeProvider = {
			...createFakeRuntimeProvider({}),
			snapshot: () =>
				Effect.fail(
					new RuntimeError({
						runtime: "herdr",
						operation: "snapshot",
						code: null,
						message: "Herdr is not running",
					}),
				),
		}
		for (const [provider, error] of [
			[null, null],
			[failing, "Herdr is not running"],
		] as const) {
			const inspection = await run(
				Effect.flatMap(RuntimeBindingService, (service) =>
					service.inspect(root, [], env),
				),
				provider,
			)
			expect(inspection).toMatchObject({
				available: false,
				error,
				bindings: [{ state: "unknown", panes: [] }],
				inferred: [],
				unmanaged: [],
			})
		}
	})
})
