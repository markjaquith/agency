import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AgencyGraph } from "../graph-schema"
import { RuntimeBindingService } from "../services/RuntimeBindingService"
import { RuntimeService } from "../services/RuntimeService"
import {
	captureLogs,
	cleanupTempDir,
	createFakeRuntimeProvider,
	createTempDir,
	fakeRuntimeService,
	runTestEffect,
	runtimePane,
} from "../test-utils"
import type { RuntimeProvider } from "../workbase/runtime"
import { context } from "./context"
import { graph } from "./graph"

const write = async (root: string, path: string, content: string) => {
	const fullPath = join(root, path)
	await mkdir(dirname(fullPath), { recursive: true })
	await Bun.write(fullPath, content)
}

const task = (id: string, status: string) => `---
ticketUrl: null
repo: agency
branch: feat/${id}
base: main
pr: null
status: ${status}
---

# ${id}
`

let tempDir: string
let root: string
const previousStateDirectory = process.env.AGENCY_STATE_DIR

beforeEach(async () => {
	tempDir = await realpath(await createTempDir())
	root = join(tempDir, "workbase")
	process.env.AGENCY_STATE_DIR = join(tempDir, "state")
	await write(root, "agency.json", '{"version":2}\n')
	await mkdir(join(root, "repos/agency"), { recursive: true })
	await write(root, "tasks/alpha/TASK.md", task("alpha", "working"))
	await write(root, "tasks/beta/TASK.md", task("beta", "open"))
})

afterEach(async () => {
	if (previousStateDirectory === undefined) delete process.env.AGENCY_STATE_DIR
	else process.env.AGENCY_STATE_DIR = previousStateDirectory
	await cleanupTempDir(tempDir)
})

const withRuntime = <A, E>(
	effect: Effect.Effect<A, E, any>,
	provider: RuntimeProvider | null,
) =>
	runTestEffect(
		effect.pipe(
			Effect.provideService(RuntimeService, fakeRuntimeService(provider)),
		),
	)

const bindAlpha = () =>
	withRuntime(
		Effect.flatMap(RuntimeBindingService, (service) =>
			service.recordLaunch({
				root,
				unit: "execution-unit:task/alpha",
				agent: "opencode2",
				agentSessionId: "ses_alpha",
				agencySessionId: "1-2",
			}),
		),
		createFakeRuntimeProvider({
			location: {
				runtime: "herdr",
				paneId: "w1:p1",
				tabId: "w1:t1",
				workspaceId: "w1",
			},
		}),
	)

const liveProvider = () =>
	createFakeRuntimeProvider({
		panes: [
			runtimePane({ paneId: "w1:p1", agentSessionId: "ses_alpha" }),
			runtimePane({ paneId: "w1:p2", cwd: join(root, "tasks/beta") }),
			runtimePane({ paneId: "w1:p9", cwd: "/elsewhere" }),
		],
	})

const output = async (
	run: () => Promise<unknown>,
): Promise<Record<string, any>> => {
	const logs = await captureLogs(run)
	expect(logs).toHaveLength(1)
	return JSON.parse(logs[0]!)
}

describe("runtime include layer", () => {
	test("graph omits runtime unless requested", async () => {
		await bindAlpha()
		const result = await output(() =>
			withRuntime(graph({ cwd: root, json: true }), liveProvider()),
		)
		expect(result.runtime).toBeUndefined()
		expect(result.nodes.some((node: any) => "runtime" in node)).toBe(false)
	})

	test("graph reconciles bindings and inferences for execution units", async () => {
		await bindAlpha()
		const result = await output(() =>
			withRuntime(
				graph({ cwd: root, json: true, include: ["runtime"] }),
				liveProvider(),
			),
		)
		expect(Schema.decodeUnknownSync(AgencyGraph)(result)).toEqual(
			result as never,
		)
		expect(result.includes).toEqual(["runtime"])
		expect(result.runtime).toMatchObject({
			provider: "herdr",
			available: true,
			error: null,
			unmanaged: [{ paneId: "w1:p9" }],
			orphaned: [],
		})
		const units = Object.fromEntries(
			result.nodes
				.filter((node: any) => node.kind === "execution-unit")
				.map((node: any) => [node.id, node.runtime]),
		)
		expect(units["execution-unit:task/alpha"]).toMatchObject({
			binding: {
				state: "live",
				record: { paneId: "w1:p1", agentSessionId: "ses_alpha" },
				panes: [{ paneId: "w1:p1" }],
			},
			inferred: [],
		})
		expect(units["execution-unit:task/beta"]).toMatchObject({
			binding: null,
			inferred: [{ matchedBy: "directory", pane: { paneId: "w1:p2" } }],
		})
	})

	test("graph filters do not orphan bindings or unmanage panes", async () => {
		await bindAlpha()
		const result = await output(() =>
			withRuntime(
				graph({
					cwd: root,
					json: true,
					statuses: ["open"],
					include: ["runtime"],
				}),
				liveProvider(),
			),
		)
		expect(result.runtime.orphaned).toEqual([])
		expect(result.runtime.unmanaged.map((pane: any) => pane.paneId)).toEqual([
			"w1:p9",
		])
		expect(result.nodes.map((node: any) => node.id)).toContain(
			"execution-unit:task/beta",
		)
	})

	test("graph reports orphaned bindings for units that no longer exist", async () => {
		await bindAlpha()
		await cleanupTempDir(join(root, "tasks/alpha"))
		const result = await output(() =>
			withRuntime(graph({ cwd: root, json: true, include: ["runtime"] }), null),
		)
		expect(result.runtime).toMatchObject({
			provider: null,
			available: false,
			orphaned: [
				{ state: "unknown", record: { unit: "execution-unit:task/alpha" } },
			],
		})
	})

	test("context includes the target unit's runtime only when requested", async () => {
		await bindAlpha()
		const target = join(root, "tasks/alpha")
		const plain = await output(() =>
			withRuntime(context({ cwd: root, target, json: true }), liveProvider()),
		)
		expect(plain.runtime).toBeUndefined()
		const result = await output(() =>
			withRuntime(
				context({ cwd: root, target, json: true, include: ["runtime"] }),
				liveProvider(),
			),
		)
		expect(result.runtime).toMatchObject({
			provider: "herdr",
			available: true,
			error: null,
			binding: { state: "live", record: { unit: "execution-unit:task/alpha" } },
			inferred: [],
		})
		const workbase = await output(() =>
			withRuntime(
				context({ cwd: root, target: root, json: true, include: ["runtime"] }),
				liveProvider(),
			),
		)
		expect(workbase.runtime).toBeNull()
	})
})
