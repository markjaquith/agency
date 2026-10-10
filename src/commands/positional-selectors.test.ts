import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
	captureLogs,
	cleanupTempDir,
	createTempDir,
	runTestEffect,
} from "../test-utils"
import { archive } from "./archive"
import { epic } from "./epic"
import { phase } from "./phase"
import { restore } from "./restore"
import { task } from "./task"

describe("positional item selectors", () => {
	let root: string

	const json = async (effect: Parameters<typeof runTestEffect>[0]) => {
		const logs = await captureLogs(() => runTestEffect(effect))
		return JSON.parse(logs[0]!)
	}

	beforeEach(async () => {
		root = await createTempDir()
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		const initialized = Bun.spawnSync([
			"git",
			"init",
			"--bare",
			join(root, "repos/agency"),
		])
		if (initialized.exitCode !== 0)
			throw new Error(new TextDecoder().decode(initialized.stderr))
		await runTestEffect(
			epic({
				subcommand: "create",
				args: ["launch"],
				ticketUrl: "https://example.com/epic",
				repos: ["agency:main"],
				cwd: root,
				silent: true,
			}),
		)
		for (const id of ["single", "other"]) {
			await runTestEffect(
				task({
					subcommand: "create",
					args: [id],
					epic: "launch",
					repo: "agency",
					branch: `task/${id}`,
					base: "main",
					cwd: root,
					silent: true,
				}),
			)
		}
		await runTestEffect(
			task({
				subcommand: "create",
				args: ["multi"],
				multiPhase: true,
				cwd: root,
				silent: true,
			}),
		)
		for (const id of ["build", "ship"]) {
			await runTestEffect(
				phase({
					subcommand: "create",
					args: ["multi", id],
					repo: "agency",
					branch: `task/multi-${id}`,
					base: "main",
					cwd: root,
					silent: true,
				}),
			)
		}
	})

	afterEach(async () => cleanupTempDir(root))

	test("task commands accept paths and default to the current task", async () => {
		const taskDirectory = join(root, "tasks/single")
		expect(
			await json(
				task({
					subcommand: "show",
					args: ["tasks/single/TASK.md"],
					cwd: root,
					json: true,
				}),
			),
		).toMatchObject({ id: "single" })

		const shown = await json(
			task({ subcommand: "show", args: [], cwd: taskDirectory, json: true }),
		)
		expect(shown.id).toBe("single")

		await expect(
			runTestEffect(
				task({
					subcommand: "update",
					args: [],
					description: "Stale",
					ifRevision: "0".repeat(64),
					cwd: taskDirectory,
					silent: true,
				}),
			),
		).rejects.toThrow("Revision conflict for tasks/single/TASK.md")
		const updated = await json(
			task({
				subcommand: "update",
				args: ["."],
				description: "Current",
				ifRevision: shown.revision,
				cwd: taskDirectory,
				json: true,
			}),
		)
		expect(updated).toMatchObject({ entity: { kind: "task", id: "single" } })

		expect(
			await json(
				task({
					subcommand: "status",
					args: ["working"],
					cwd: taskDirectory,
					json: true,
				}),
			),
		).toMatchObject({ id: "single", data: { status: "working" } })

		await runTestEffect(
			task({
				subcommand: "dependency",
				args: ["add", "../other"],
				cwd: taskDirectory,
				silent: true,
			}),
		)
		const parent = await json(
			epic({ subcommand: "show", args: ["launch"], cwd: root, json: true }),
		)
		expect(parent.data.tasks).toContainEqual({
			id: "single",
			dependsOn: ["other"],
		})
	})

	test("phase commands accept phase paths and phase IDs of the current task", async () => {
		const phaseDirectory = join(root, "tasks/multi/phases/build")
		expect(
			await json(
				phase({
					subcommand: "show",
					args: [],
					cwd: phaseDirectory,
					json: true,
				}),
			),
		).toMatchObject({ id: "build", taskId: "multi" })
		expect(
			await json(
				phase({
					subcommand: "show",
					args: ["ship"],
					cwd: join(root, "tasks/multi"),
					json: true,
				}),
			),
		).toMatchObject({ id: "ship", taskId: "multi" })
		expect(
			await json(
				phase({
					subcommand: "status",
					args: ["tasks/multi/phases/build/PHASE.md", "working"],
					cwd: root,
					json: true,
				}),
			),
		).toMatchObject({ id: "build", data: { status: "working" } })
		expect(
			await json(
				phase({
					subcommand: "status",
					args: ["multi", "ship", "working"],
					cwd: root,
					json: true,
				}),
			),
		).toMatchObject({ id: "ship", data: { status: "working" } })
		const listed = await json(
			phase({ subcommand: "list", args: [], cwd: phaseDirectory, json: true }),
		)
		expect(listed.map((record: { id: string }) => record.id)).toEqual([
			"build",
			"ship",
		])
		await expect(
			runTestEffect(
				phase({
					subcommand: "show",
					args: [],
					cwd: join(root, "tasks/multi"),
					silent: true,
				}),
			),
		).rejects.toThrow("does not identify an active phase")
	})

	test("phase create defaults to the current task", async () => {
		const created = await json(
			phase({
				subcommand: "create",
				args: ["verify"],
				repo: "agency",
				branch: "task/multi-verify",
				base: "main",
				cwd: join(root, "tasks/multi"),
				json: true,
			}),
		)
		expect(created).toMatchObject({ id: "verify", taskId: "multi" })
	})

	test("epic commands accept paths and default to the current epic", async () => {
		expect(
			await json(
				epic({
					subcommand: "show",
					args: [],
					cwd: join(root, "epics/launch"),
					json: true,
				}),
			),
		).toMatchObject({ id: "launch" })
		await runTestEffect(
			epic({
				subcommand: "rename",
				args: ["epics/launch/EPIC.md", "liftoff"],
				cwd: root,
				silent: true,
			}),
		)
		expect(await Bun.file(join(root, "epics/liftoff/EPIC.md")).exists()).toBe(
			true,
		)
	})

	test("archive and restore accept active and archived paths", async () => {
		await runTestEffect(
			task({
				subcommand: "status",
				args: ["other", "dropped"],
				cwd: root,
				silent: true,
			}),
		)
		await runTestEffect(
			archive({
				type: "task",
				args: [],
				cwd: join(root, "tasks/other"),
				silent: true,
			}),
		)
		expect(
			await Bun.file(join(root, "archive/tasks/other/TASK.md")).exists(),
		).toBe(true)
		const shown = await json(
			archive({
				type: "show",
				args: ["task", "archive/tasks/other"],
				cwd: root,
				json: true,
			}),
		)
		expect(shown).toMatchObject({ kind: "task", id: "other" })
		await runTestEffect(
			restore({
				type: "task",
				args: [],
				cwd: join(root, "archive/tasks/other"),
				silent: true,
			}),
		)
		expect(await Bun.file(join(root, "tasks/other/TASK.md")).exists()).toBe(
			true,
		)
		await expect(
			runTestEffect(
				restore({
					type: "task",
					args: ["tasks/other"],
					cwd: root,
					silent: true,
				}),
			),
		).rejects.toThrow("identifies an active task, not an archived task")
	})
})
