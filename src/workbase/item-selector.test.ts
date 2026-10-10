import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import {
	locateItem,
	resolveDependencySelector,
	resolveEpicSelector,
	resolvePhaseSelector,
	resolveTaskSelector,
	splitSelectorArgs,
} from "./item-selector"

const touch = async (root: string, path: string) => {
	await mkdir(dirname(join(root, path)), { recursive: true })
	await Bun.write(join(root, path), "")
}

describe("locateItem", () => {
	test("maps workbase paths to items", () => {
		const root = "/w"
		expect(locateItem(root, "/w/epics/e/EPIC.md")).toEqual({
			kind: "epic",
			archived: false,
			epicId: "e",
		})
		expect(locateItem(root, "/w/tasks/t/code/agency/src")).toEqual({
			kind: "task",
			archived: false,
			taskId: "t",
		})
		expect(locateItem(root, "/w/tasks/t/phases/p/code")).toEqual({
			kind: "phase",
			archived: false,
			taskId: "t",
			phaseId: "p",
		})
		expect(locateItem(root, "/w/archive/tasks/t/phases/p")).toEqual({
			kind: "phase",
			archived: true,
			taskId: "t",
			phaseId: "p",
		})
		for (const path of ["/w", "/w/tasks", "/w/repos/agency", "/elsewhere"])
			expect(locateItem(root, path)).toBeNull()
	})
})

describe("item selectors", () => {
	let root: string

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await touch(root, "epics/launch/EPIC.md")
		await touch(root, "tasks/single/TASK.md")
		await touch(root, "tasks/multi/TASK.md")
		await touch(root, "tasks/multi/phases/build/PHASE.md")
		await touch(root, "tasks/multi/phases/build/code/agency/README.md")
		await touch(root, "archive/tasks/old/TASK.md")
		await touch(root, "archive/tasks/multi/phases/gone/PHASE.md")
	})

	afterEach(async () => cleanupTempDir(root))

	const task = (selector: string | undefined, cwd = root, archived?: boolean) =>
		runTestEffect(resolveTaskSelector(selector, cwd, { archived }))
	const phase = (
		selector: string | undefined,
		phaseId: string | undefined,
		cwd = root,
		archived?: boolean,
	) => runTestEffect(resolvePhaseSelector(selector, phaseId, cwd, { archived }))

	test("treats bare selectors as IDs and preserves unknown IDs", async () => {
		expect(await task("single")).toMatchObject({ taskId: "single" })
		expect(await task("missing")).toMatchObject({ taskId: "missing" })
		expect(
			await runTestEffect(resolveEpicSelector("launch", root)),
		).toMatchObject({ epicId: "launch" })
	})

	test("prefers an existing ID over a same-named relative path", async () => {
		await touch(root, "tasks/multi/single/notes.md")
		expect(await task("single", join(root, "tasks/multi"))).toMatchObject({
			taskId: "single",
			phaseId: undefined,
		})
	})

	test("resolves document, directory, and nested paths", async () => {
		expect(await task("tasks/single/TASK.md")).toMatchObject({
			root,
			taskId: "single",
		})
		expect(await task("./tasks/single")).toMatchObject({ taskId: "single" })
		expect(
			await task(".", join(root, "tasks/multi/phases/build/code/agency")),
		).toEqual({ root, taskId: "multi", phaseId: "build" })
		expect(
			await runTestEffect(resolveEpicSelector("epics/launch/EPIC.md", root)),
		).toEqual({ root, epicId: "launch" })
	})

	test("defaults to the item containing the current directory", async () => {
		expect(await task(undefined, join(root, "tasks/single"))).toMatchObject({
			taskId: "single",
		})
		expect(
			await runTestEffect(
				resolveEpicSelector(undefined, join(root, "epics/launch")),
			),
		).toMatchObject({ epicId: "launch" })
		await expect(task(undefined)).rejects.toThrow(
			`current directory ${root} does not identify an active task`,
		)
	})

	test("rejects paths for the wrong item kind or archive state", async () => {
		await expect(task("epics/launch")).rejects.toThrow(
			"does not identify an active task",
		)
		await expect(task("archive/tasks/old")).rejects.toThrow(
			"identifies an archived task, not an active task",
		)
		await expect(task("tasks/nope")).rejects.toThrow("Path does not exist")
		expect(await task("archive/tasks/old", root, true)).toMatchObject({
			taskId: "old",
		})
	})

	test("resolves phase selector shapes", async () => {
		expect(await phase("multi", "build")).toMatchObject({
			taskId: "multi",
			phaseId: "build",
		})
		expect(await phase("tasks/multi/phases/build/PHASE.md", undefined)).toEqual(
			{ root, taskId: "multi", phaseId: "build" },
		)
		expect(
			await phase(undefined, undefined, join(root, "tasks/multi/phases/build")),
		).toMatchObject({ taskId: "multi", phaseId: "build" })
		expect(
			await phase("build", undefined, join(root, "tasks/multi")),
		).toMatchObject({ taskId: "multi", phaseId: "build" })
		await expect(phase("build", undefined)).rejects.toThrow(
			"Phase selector 'build' requires a task",
		)
		await expect(phase("tasks/multi", undefined)).rejects.toThrow(
			"does not identify an active phase",
		)
	})

	test("resolves archived phases beneath an active task", async () => {
		expect(
			await phase("gone", undefined, join(root, "tasks/multi"), true),
		).toMatchObject({ taskId: "multi", phaseId: "gone" })
		expect(
			await phase("archive/tasks/multi/phases/gone", undefined, root, true),
		).toMatchObject({ taskId: "multi", phaseId: "gone" })
	})

	test("resolves dependency paths and preserves bare dependency IDs", async () => {
		expect(
			await runTestEffect(
				resolveDependencySelector("task", "tasks/single", root),
			),
		).toBe("single")
		expect(
			await runTestEffect(resolveDependencySelector("task", "anything", root)),
		).toBe("anything")
		expect(
			await runTestEffect(
				resolveDependencySelector("phase", "tasks/multi/phases/build", root),
			),
		).toBe("build")
	})
})

describe("splitSelectorArgs", () => {
	test("keeps trailing operands and leaves optional selectors", () => {
		expect(splitSelectorArgs(["done"], 1)).toEqual({
			selectors: [],
			operands: ["done"],
		})
		expect(splitSelectorArgs(["t", "p", "done"], 1)).toEqual({
			selectors: ["t", "p"],
			operands: ["done"],
		})
	})
})
