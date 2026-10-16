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

const location = {
	runtime: "herdr" as const,
	paneId: "w1:p2",
	tabId: "w1:t2",
	workspaceId: "w1",
}

const launch = (unit = "execution-unit:task/alpha") =>
	Effect.flatMap(RuntimeBindingService, (service) =>
		service.recordLaunch(
			{
				root,
				unit,
				agent: "opencode2",
				agentSessionId: "ses_a",
				agencySessionId: "1-2",
			},
			env,
		),
	)

describe("RuntimeBindingService", () => {
	test("stores bindings under the XDG or home state directory by default", async () => {
		const provider = createFakeRuntimeProvider({ location })
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
			await run(launch(), provider)
			expect(await readdir(directory)).toEqual(["runtime-bindings"])
		}
	})

	test("records nothing outside a runtime", async () => {
		expect(await run(launch())).toBeNull()
		expect(
			await run(launch(), createFakeRuntimeProvider({ location: null })),
		).toBeNull()
		expect(await readdir(tempDir)).toEqual(["workbase"])
	})

	test("records the current pane and lists bindings per workbase unit", async () => {
		const provider = createFakeRuntimeProvider({ location })
		const recorded = await run(launch(), provider)
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
		await run(launch("execution-unit:phase/beta/build"), provider)
		// Relaunching replaces the unit's binding.
		await run(
			launch(),
			createFakeRuntimeProvider({ location: { ...location, paneId: "w9:p1" } }),
		)

		const bindings = await run(
			Effect.flatMap(RuntimeBindingService, (service) =>
				service.list(root, env),
			),
		)
		expect(bindings.map((item) => [item.unit, item.paneId])).toEqual([
			["execution-unit:phase/beta/build", "w1:p2"],
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
		const provider = createFakeRuntimeProvider({ location })
		const recorded = await run(launch(), provider)
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
		await run(launch(), createFakeRuntimeProvider({ location }))
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
		await run(launch(), createFakeRuntimeProvider({ location }))
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
