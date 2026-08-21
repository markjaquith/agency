import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { documentRevision } from "./document-revision"
import {
	assessValidationEvidence,
	buildExecutionContract,
	buildValidationEvidence,
	EXECUTION_SOURCE_LOCATIONS,
	normalizeRecalledContext,
	parseValidationEvidence,
	readValidationEvidence,
} from "./execution-contract"

describe("execution contract", () => {
	let root: string
	let taskPath: string
	let taskContent: string

	beforeEach(async () => {
		root = await createTempDir()
		taskPath = join(root, "tasks/example/TASK.md")
		taskContent =
			"---\nticketUrl: null\nrepo: agency\nbranch: task/example\nbase: main\npr: null\nstatus: open\n---\n\n# Example\n"
		await mkdir(join(root, "repos/agency"), { recursive: true })
		await mkdir(join(root, "tasks/example"), { recursive: true })
		await Bun.write(join(root, "agency.json"), '{"version":2}\n')
		await Bun.write(taskPath, taskContent)
	})

	afterEach(async () => cleanupTempDir(root))

	const createEvidence = () =>
		runTestEffect(
			buildValidationEvidence({
				startPath: root,
				target: "execution-unit:task/example",
				documentPath: taskPath,
				documentRevision: documentRevision(taskContent),
				recalledContext: normalizeRecalledContext({
					id: "example",
					repo: "agency",
					base: "main",
				}),
			}),
		)

	test("reuses evidence only for the same workbase and revision", async () => {
		const evidence = await createEvidence()
		expect(parseValidationEvidence(evidence)).toEqual(evidence)
		const assessment = await runTestEffect(
			assessValidationEvidence({
				evidence,
				startPath: root,
				target: evidence.target,
				documentPath: taskPath,
				documentRevision: evidence.documentRevision,
			}),
		)
		expect(assessment.disposition).toEqual({ status: "reused", reasons: [] })
	})

	test("treats legacy creation output as a validation refresh", async () => {
		expect(
			await runTestEffect(
				readValidationEvidence(
					JSON.stringify({ version: 1, ok: true, result: { id: "example" } }),
					root,
				),
			),
		).toBeUndefined()
	})

	test("refreshes evidence after document, config, mapping, or payload changes", async () => {
		const evidence = await createEvidence()
		const changedContent = `${taskContent}\nChanged\n`
		await Bun.write(taskPath, changedContent)
		await mkdir(join(root, "repos/other"), { recursive: true })
		await Bun.write(
			join(root, "agency.json"),
			'{"version":2,"repositories":{"other":{"remote":"https://example.com/other.git"}}}\n',
		)
		const assessment = await runTestEffect(
			assessValidationEvidence({
				evidence: { ...evidence, digest: "0".repeat(64) },
				startPath: root,
				target: evidence.target,
				documentPath: taskPath,
				documentRevision: documentRevision(changedContent),
			}),
		)
		expect(assessment.disposition.status).toBe("refreshed")
		expect(assessment.disposition.reasons).toEqual(
			expect.arrayContaining([
				"digest-mismatch",
				"document-revision-changed",
				"workbase-revision-changed",
				"configuration-changed",
				"repository-mapping-changed",
			]),
		)
	})

	test("describes prepared execution without prescribing orchestration", () => {
		const checkoutPath = join(root, "tasks/example/code/agency")
		const applied = buildExecutionContract({
			workbaseRoot: root,
			target: "execution-unit:task/example",
			taskPath,
			checkoutPath,
			documentRevision: "a".repeat(64),
			dryRun: false,
		})
		const phasePath = join(root, "tasks/example/phases/implementation/PHASE.md")
		const preview = buildExecutionContract({
			workbaseRoot: root,
			target: "execution-unit:phase/example/implementation",
			taskPath,
			phasePath,
			checkoutPath: join(
				root,
				"tasks/example/phases/implementation/code/agency",
			),
			documentRevision: "b".repeat(64),
			dryRun: true,
		})
		expect(applied).toMatchObject({
			capability: "agency-execution-v1",
			mode: "applied",
			workspace: {
				state: "materialized",
				checkoutPath,
			},
			commands: {
				work: {
					cwd: dirname(taskPath),
					argv: ["agency", "work", ".", "--auto"],
				},
			},
		})
		expect(applied.sourceLocations).toEqual(EXECUTION_SOURCE_LOCATIONS)
		expect(preview).toMatchObject({
			mode: "preview",
			workspace: { state: "planned" },
			plannedActions: [{ kind: "workspace-materialization" }],
			commands: {
				context: { cwd: dirname(phasePath) },
			},
		})
		expect(applied.executionIdentity.key).toBe(
			buildExecutionContract({
				workbaseRoot: root,
				target: "execution-unit:task/example",
				taskPath,
				documentRevision: "a".repeat(64),
				dryRun: true,
			}).executionIdentity.key,
		)
	})
})
