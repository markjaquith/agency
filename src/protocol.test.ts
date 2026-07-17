import { describe, expect, test } from "bun:test"
import { Schema } from "@effect/schema"
import errorFixture from "../fixtures/protocol/error.json"
import successFixture from "../fixtures/protocol/success.json"
import jsonSchema from "../schemas/agency-envelope-v1.schema.json"
import {
	AgencyEnvelope,
	collectCommandResult,
	emitCommandResult,
	errorEnvelope,
	successEnvelope,
} from "./protocol"

describe("machine protocol", () => {
	test("accepts the representative success and error fixtures", () => {
		for (const fixture of [successFixture, errorFixture]) {
			const decoded = Schema.decodeUnknownSync(AgencyEnvelope, {
				onExcessProperty: "error",
			})(fixture)
			expect(JSON.stringify(decoded)).toBe(JSON.stringify(fixture))
		}
	})

	test("publishes the matching v1 JSON Schema", () => {
		expect(jsonSchema).toMatchObject({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			title: "Agency machine result envelope v1",
			oneOf: [
				{ properties: { version: { const: 1 }, ok: { const: true } } },
				{ properties: { version: { const: 1 }, ok: { const: false } } },
			],
		})
	})

	test("collects one command result without writing it", async () => {
		const result = await collectCommandResult(async () => {
			emitCommandResult('{"value":42}')
		})
		expect(successEnvelope(result)).toEqual({
			version: 1,
			ok: true,
			result: { value: 42 },
		})
		expect(successEnvelope(undefined).result).toBeNull()
	})

	test("rejects commands that emit multiple machine results", async () => {
		await expect(
			collectCommandResult(async () => {
				emitCommandResult("first")
				emitCommandResult("second")
			}),
		).rejects.toThrow("more than one result")
	})

	test("normalizes unknown failures into stable error details", () => {
		expect(errorEnvelope(new Error("boom"))).toEqual({
			version: 1,
			ok: false,
			error: {
				code: "COMMAND_FAILED",
				message: "boom",
				fields: {},
				retryable: false,
			},
		})
	})

	test("preserves relevant fields from classified errors", () => {
		expect(
			errorEnvelope({
				_tag: "ValidationFailedError",
				message: "invalid workbase",
				root: "/work/agency",
				issues: [{ path: "TASK.md", message: "invalid status" }],
			}),
		).toMatchObject({
			error: {
				code: "VALIDATION_FAILED",
				fields: {
					root: "/work/agency",
					issues: [{ path: "TASK.md", message: "invalid status" }],
				},
			},
		})
		expect(
			errorEnvelope({
				_tag: "ClaimConflictError",
				message: "already claimed",
				target: "task 'example'",
				currentRevision: "a".repeat(64),
				claim: {
					claimant: "orchestrator",
					runner: "agent",
					sessionId: "job-1",
					startedAt: "2026-07-17T12:00:00.000Z",
					targetRevision: "0".repeat(64),
					state: "active",
				},
			}),
		).toMatchObject({
			error: {
				code: "CLAIM_CONFLICT",
				retryable: true,
				fields: {
					target: "task 'example'",
					claim: { runner: "agent", sessionId: "job-1" },
				},
			},
		})
		expect(
			errorEnvelope({
				_tag: "RevisionConflictError",
				message: "revision conflict",
				path: "tasks/example/TASK.md",
				expectedRevision: "a".repeat(64),
				currentRevision: "b".repeat(64),
			}),
		).toMatchObject({
			error: {
				code: "REVISION_CONFLICT",
				retryable: true,
				fields: {
					path: "tasks/example/TASK.md",
					expectedRevision: "a".repeat(64),
					currentRevision: "b".repeat(64),
				},
			},
		})
	})
})
