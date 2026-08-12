import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { documentRevision } from "./document-revision"
import {
	assessValidationEvidence,
	buildKickoffPlan,
	buildValidationEvidence,
	KICKOFF_SOURCE_LOCATIONS,
	normalizeRecalledContext,
	parseValidationEvidence,
	readValidationEvidence,
} from "./kickoff-contract"

describe("kickoff contract", () => {
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

	test("plans retry-safe single-phase and phased launches with one verification", () => {
		const single = buildKickoffPlan({
			workbaseRoot: root,
			target: "execution-unit:task/example",
			taskId: "example",
			taskPath,
			checkoutPath: join(root, "tasks/example/code/agency"),
			documentRevision: "a".repeat(64),
		})
		const phased = buildKickoffPlan({
			workbaseRoot: root,
			target: "execution-unit:phase/example/implementation",
			taskId: "example",
			phaseId: "implementation",
			taskPath,
			phasePath: join(root, "tasks/example/phases/implementation/PHASE.md"),
			documentRevision: "b".repeat(64),
		})
		expect(single.steps[0]?.argv).toContain("example")
		expect(phased.steps[0]?.argv).toEqual(
			expect.arrayContaining(["example", "implementation"]),
		)
		expect(
			single.steps.filter(({ id }) => id === "final-context-verification"),
		).toHaveLength(1)
		expect(single.orchestrator.knownCurrentCommandsBypassDiscovery).toBe(true)
		expect(single.sourceLocations).toEqual(KICKOFF_SOURCE_LOCATIONS)
		expect(
			single.steps.find(({ id }) => id === "herdr-tab")?.recovery,
		).toContain("never create a duplicate")
		expect(single.idempotencyKey).toBe(
			buildKickoffPlan({
				workbaseRoot: root,
				target: "execution-unit:task/example",
				taskId: "example",
				taskPath,
				documentRevision: "a".repeat(64),
			}).idempotencyKey,
		)
	})
})
