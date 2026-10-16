import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { RuntimeService } from "../services/RuntimeService"
import { SupervisionStateService } from "../services/SupervisionStateService"
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

const fakeUi = (answers: { choose?: string | null; confirm?: boolean }) => {
	const models: SuperviseModel[] = []
	const notices: string[] = []
	const confirmations: { title: string; preview: readonly string[] }[] = []
	let handlers: SupervisorUiHandlers | undefined
	let closed = false
	const ui: SupervisorUi = {
		update: (model) => models.push(model),
		status: () => {},
		notice: (text) => notices.push(text),
		confirm: async (request) => {
			confirmations.push(request)
			return answers.confirm ?? true
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
		ui.handlers().onQuit()
		await done
		expect(
			await Bun.file(join(root, ".agency/supervisor-prompt.md")).text(),
		).toBe("Prefer small PRs.\n")
	})

	test("requires an interactive terminal", async () => {
		await expect(
			runTestEffect(supervise({ inputAllowed: false })),
		).rejects.toThrow("agency supervise requires an interactive terminal")
	})
})
