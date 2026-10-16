import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { RuntimeService } from "../services/RuntimeService"
import { SupervisionStateService } from "../services/SupervisionStateService"
import { TriageService } from "../services/TriageService"
import { WorkbaseService } from "../services/WorkbaseService"
import {
	cleanupTempDir,
	createFakeRuntimeProvider,
	createTempDir,
	fakeRuntimeService,
	runTestEffect,
	runtimePane,
} from "../test-utils"
import type { SuperviseModel } from "../workbase/supervise-view"
import { supervise } from "./supervise"

type OpenUi = NonNullable<Parameters<typeof supervise>[1]>
type SupervisorUi = Awaited<ReturnType<OpenUi>>
type SupervisorUiHandlers = Parameters<OpenUi>[0]

let tempDir: string
let root: string
let configDirectory: string
let env: NodeJS.ProcessEnv

const write = async (path: string, content: string) => {
	await mkdir(dirname(path), { recursive: true })
	await Bun.write(path, content)
}

beforeEach(async () => {
	tempDir = await realpath(await createTempDir())
	root = join(tempDir, "workbase")
	configDirectory = join(tempDir, "config")
	env = { ...process.env, AGENCY_STATE_DIR: join(tempDir, "state") }
	await write(join(root, "agency.json"), '{"version":2}\n')
	await mkdir(join(root, "repos/agency"), { recursive: true })
	await runTestEffect(
		Effect.flatMap(WorkbaseService, (service) =>
			service.register(root, configDirectory, "main"),
		),
	)
})

afterEach(() => cleanupTempDir(tempDir))

const waitFor = async <A>(read: () => A | undefined, label: string) => {
	const deadline = Date.now() + 8_000
	while (Date.now() < deadline) {
		const value = read()
		if (value !== undefined) return value
		await Bun.sleep(10)
	}
	throw new Error(`Timed out waiting for ${label}`)
}

const fakeUi = (answers: {
	choose?: string | null
	confirm?: boolean
	/** Hold confirmations open until the test settles them. */
	holdConfirm?: boolean
}) => {
	const held: ((value: {
		confirmed: boolean
		destructiveConfirmed: boolean
	}) => void)[] = []
	const models: SuperviseModel[] = []
	const notices: string[] = []
	const confirmations: { title: string; preview: readonly string[] }[] = []
	let handlers: SupervisorUiHandlers | undefined
	let closed = false
	const ui: SupervisorUi = {
		update: (model) => models.push(model),
		status: () => {},
		notice: (text) => notices.push(text),
		confirm: (request) => {
			confirmations.push(request)
			if (answers.holdConfirm)
				return new Promise((resolve) => {
					held.push(resolve)
				})
			const confirmed = answers.confirm ?? true
			return Promise.resolve({
				confirmed,
				destructiveConfirmed: confirmed,
			})
		},
		text: async () => null,
		choose: async () => answers.choose ?? null,
		suspend: () => {},
		resume: () => {},
		close: async () => {
			closed = true
		},
	}
	return {
		open: async (next: SupervisorUiHandlers) => {
			handlers = next
			return ui
		},
		models,
		notices,
		confirmations,
		handlers: () => handlers!,
		closed: () => closed,
		held,
	}
}

describe("agency supervise", () => {
	test("shows unmanaged panes, runs a confirmed action, and snoozes", async () => {
		const calls: unknown[][] = []
		await mkdir(join(tempDir, "elsewhere"))
		const provider = createFakeRuntimeProvider({
			calls,
			panes: [
				runtimePane({
					paneId: "w1:p7",
					tabId: "w1:t7",
					agentSessionId: "ses_7",
					cwd: join(tempDir, "elsewhere"),
				}),
			],
		})
		const ui = fakeUi({ choose: "3600000" })
		const done = runTestEffect(
			supervise(
				{
					cwd: root,
					configDirectory,
					env,
					agencyCommand: ["false"],
					pollSeconds: 3600,
				},
				ui.open,
			).pipe(
				Effect.provideService(RuntimeService, fakeRuntimeService(provider)),
			),
		)
		const model = await waitFor(() => ui.models[0], "the first model")
		const group = model.groups.find((item) => item.label === "Unmanaged")!
		const item = group.items[0]!
		expect(item).toMatchObject({
			key: "herdr:w1:p7",
			badge: { label: "Unmanaged" },
		})
		const focus = item.actions.find((action) => action.type === "runtime")!
		ui.handlers().onExecute(item, focus)
		await waitFor(
			() => ui.notices.find((notice) => notice.startsWith("✓")),
			"the action to finish",
		)
		expect(ui.confirmations).toEqual([
			expect.objectContaining({
				title: "Focus pane w1:p7",
				preview: ["herdr: focus pane w1:p7"],
			}),
		])
		expect(calls).toContainEqual(["focus", "pane", "w1:p7"])
		ui.handlers().onFocus(item)
		await waitFor(
			() => (calls.length === 2 ? true : undefined),
			"the focus key",
		)

		const before = ui.models.length
		ui.handlers().onSnooze(item)
		const after = await waitFor(
			() => (ui.models.length > before ? ui.models.at(-1) : undefined),
			"a re-render",
		)
		expect(after).toMatchObject({ total: 0, snoozed: 1 })
		ui.handlers().onQuit()
		await done
		expect(ui.closed()).toBe(true)

		const log = await runTestEffect(
			Effect.flatMap(SupervisionStateService, (state) =>
				state.actions({}, env),
			),
		)
		expect(log).toMatchObject([
			{ key: "herdr:w1:p7", type: "runtime", outcome: "succeeded" },
			{ key: "herdr:w1:p7", type: "runtime", outcome: "succeeded" },
		])
	})

	test("logs a declined confirmation without running", async () => {
		const calls: unknown[][] = []
		const provider = createFakeRuntimeProvider({
			calls,
			panes: [runtimePane({ paneId: "w1:p7", cwd: join(tempDir, "x") })],
		})
		const ui = fakeUi({ confirm: false })
		const done = runTestEffect(
			supervise(
				{ cwd: root, configDirectory, env, agencyCommand: ["false"] },
				ui.open,
			).pipe(
				Effect.provideService(RuntimeService, fakeRuntimeService(provider)),
			),
		)
		const model = await waitFor(() => ui.models[0], "the first model")
		const item = model.groups.at(-1)!.items[0]!
		ui.handlers().onExecute(item, item.actions.at(-1)!)
		await waitFor(
			() => ui.notices.find((notice) => notice.startsWith("Cancelled")),
			"the cancellation",
		)
		ui.handlers().onQuit()
		await done
		expect(calls).toEqual([])
		const log = await runTestEffect(
			Effect.flatMap(SupervisionStateService, (state) =>
				state.actions({}, env),
			),
		)
		expect(log).toMatchObject([{ outcome: "cancelled" }])
	})

	test("edits the workbase prompt in $EDITOR", async () => {
		const editor = join(tempDir, "editor.sh")
		await write(editor, '#!/bin/sh\necho "Prefer small PRs." > "$1"\n')
		const ui = fakeUi({})
		const done = runTestEffect(
			supervise(
				{
					cwd: root,
					configDirectory,
					env: { ...env, VISUAL: `sh ${editor}` },
					agencyCommand: ["false"],
				},
				ui.open,
			).pipe(Effect.provideService(RuntimeService, fakeRuntimeService(null))),
		)
		await waitFor(() => ui.models[0], "the first model")
		ui.handlers().onEditPrompt(null)
		await waitFor(
			() => ui.notices.find((notice) => notice.startsWith("Saved")),
			"the editor",
		)
		expect(ui.notices.at(-1)).toBe(
			`Saved ${join(root, "triage.md")} and set triage.promptFile`,
		)
		expect(ui.confirmations[0]?.preview).toEqual([
			`Set "triage": { "promptFile": "triage.md" } in ${join(root, "agency.json")}`,
		])
		expect(await Bun.file(join(root, "triage.md")).text()).toBe(
			"Prefer small PRs.\n",
		)
		expect(await Bun.file(join(root, "agency.json")).json()).toMatchObject({
			triage: { promptFile: "triage.md" },
		})

		// A configured prompt file is edited in place, without asking again.
		await write(
			join(root, "agency.json"),
			JSON.stringify({
				version: 2,
				triage: { prompt: "Be brief.", promptFile: "prompts/mine.md" },
			}),
		)
		ui.handlers().onEditPrompt(null)
		await waitFor(
			() => ui.notices.find((notice) => notice.includes("prompts/mine.md")),
			"the configured prompt",
		)
		ui.handlers().onQuit()
		await done
		expect(ui.confirmations).toHaveLength(1)
		expect(await Bun.file(join(root, "prompts/mine.md")).text()).toBe(
			"Prefer small PRs.\n",
		)
	})

	test("triages the selected item or everything and merges the results", async () => {
		await mkdir(join(tempDir, "elsewhere"))
		const pane = runtimePane({
			paneId: "w1:p7",
			tabId: "w1:t7",
			agentSessionId: "ses_7",
			cwd: join(tempDir, "elsewhere"),
		})
		const calls: unknown[][] = []
		const provider = createFakeRuntimeProvider({ calls, panes: [pane] })
		const triageCalls: (string | undefined)[] = []
		const ui = fakeUi({})
		const done = runTestEffect(
			supervise(
				{ cwd: root, configDirectory, env, agencyCommand: ["false"] },
				ui.open,
			).pipe(
				Effect.provideService(RuntimeService, fakeRuntimeService(provider)),
				Effect.provideService(TriageService, {
					triage: (options) => {
						triageCalls.push(options?.item)
						const model = ui.models[0]!
						const item = model.groups.at(-1)!.items[0]!
						const written = {
							...item.actions[0]!,
							id: "triage:focus-written",
							title: "Look at the waiting agent",
							preconditions: [
								{
									kind: "pane_matches",
									runtime: "herdr",
									paneId: "w1:p7",
									tabId: "w1:t7",
									cwd: join(tempDir, "elsewhere"),
									agentSessionId: "ses_7",
									agentStatuses: ["idle"],
								},
							],
						}
						return Effect.succeed({
							version: 1,
							generatedAt: new Date().toISOString(),
							runtime: { provider: "herdr", available: true, error: null },
							workbases: [],
							items: [
								{
									key: item.key,
									subject: item.subject,
									fingerprint: "fp",
									source: "fresh",
									evaluatedAt: new Date().toISOString(),
									assessment: {
										status: "needs_input",
										summary: "Waiting for a decision",
										question: null,
										actions: [
											written,
											{ ...written, id: "triage:bogus", type: "teleport" },
										],
										modelActionIds: ["triage:focus-written", "triage:bogus"],
									},
									suppressed: null,
									error: null,
								},
							],
							failures: [],
							summary: { total: 1, fresh: 1, cached: 0, stale: 0, failed: 0 },
						} as never)
					},
				}),
			),
		)
		const first = await waitFor(() => ui.models[0], "the first model")
		ui.handlers().onTriage(first.groups.at(-1)!.items[0]!)
		const merged = await waitFor(
			() =>
				ui.models.find(
					(model) =>
						model.groups.at(-1)?.items[0]?.summary === "Waiting for a decision",
				),
			"the triage result",
		)
		const item = merged.groups.at(-1)!.items[0]!
		expect(triageCalls).toEqual(["herdr:w1:p7"])
		expect(item).toMatchObject({
			badge: { label: "Needs You" },
			modelActionIds: ["triage:focus-written"],
			triage: { source: "fresh" },
		})
		expect(item.actions[0]!.id).toBe("triage:focus-written")
		expect(ui.notices).toContain(
			"Ignored 1 triage action(s) that failed the action schema",
		)

		// The model-written action still goes through the executor's checks.
		ui.handlers().onExecute(item, item.actions[0]!)
		await waitFor(
			() => ui.notices.find((notice) => notice.startsWith("✓ Look at")),
			"the triage action",
		)
		expect(calls).toEqual([["focus", "pane", "w1:p7"]])

		ui.handlers().onTriage(null)
		await waitFor(
			() => (triageCalls.length === 2 ? true : undefined),
			"a full run",
		)
		expect(triageCalls[1]).toBeUndefined()
		ui.handlers().onQuit()
		await done
	})

	test("a second Enter while one action is pending opens nothing and runs nothing", async () => {
		const calls: unknown[][] = []
		await mkdir(join(tempDir, "elsewhere"))
		const provider = createFakeRuntimeProvider({
			calls,
			panes: [
				runtimePane({ paneId: "w1:p7", cwd: join(tempDir, "elsewhere") }),
			],
		})
		const ui = fakeUi({ holdConfirm: true })
		const done = runTestEffect(
			supervise(
				{ cwd: root, configDirectory, env, agencyCommand: ["false"] },
				ui.open,
			).pipe(
				Effect.provideService(RuntimeService, fakeRuntimeService(provider)),
			),
		)
		const model = await waitFor(() => ui.models[0], "the first model")
		const item = model.groups.at(-1)!.items[0]!
		const focus = item.actions.find((action) => action.type === "runtime")!
		ui.handlers().onExecute(item, focus)
		ui.handlers().onExecute(item, focus)
		ui.handlers().onFocus(item)
		await waitFor(() => ui.held[0], "the dialog")
		await Bun.sleep(50)
		expect(ui.confirmations).toHaveLength(1)
		// Quitting cancels the open dialog, as the real UI does.
		ui.held[0]!({ confirmed: false, destructiveConfirmed: false })
		ui.handlers().onQuit()
		await done
		expect(ui.confirmations).toHaveLength(1)
		expect(calls).toEqual([])
	})

	test("requires an interactive terminal", async () => {
		await expect(
			runTestEffect(supervise({ inputAllowed: false })),
		).rejects.toThrow("agency supervise requires an interactive terminal")
	})
})
