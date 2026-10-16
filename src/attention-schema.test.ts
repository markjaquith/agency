import { describe, expect, test } from "bun:test"
import actionSchema from "../schemas/agency-action-v1.schema.json"
import attentionSchema from "../schemas/agency-attention-v1.schema.json"
import {
	ActionPrecondition,
	AttentionSignalKind,
	SupervisorAction,
} from "./attention-schema"

describe("attention contracts", () => {
	test("publishes the v1 action JSON Schema", () => {
		expect(actionSchema).toMatchObject({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$id: "https://github.com/markjaquith/agency/schemas/agency-action-v1.schema.json",
			title: "Agency supervisor action v1",
			properties: { version: { const: 1 } },
		})
		const types = SupervisorAction.members.map(
			(member) => member.fields.type.literal,
		)
		expect(actionSchema.properties.type.enum).toEqual(types)
		expect(
			actionSchema.allOf.map((rule) => rule.if.properties.type.const),
		).toEqual(types)
		for (const type of types) {
			expect(actionSchema.$defs).toHaveProperty(`${type}Payload`)
		}
		expect(
			actionSchema.$defs.precondition.oneOf.map(
				(variant) => variant.properties.kind.const,
			),
		).toEqual(
			ActionPrecondition.members.map((member) => member.fields.kind.literal),
		)
		expect(actionSchema.properties.risk.enum).toEqual([
			"read-only",
			"reversible",
			"destructive",
		])
	})

	test("publishes the v1 attention JSON Schema", () => {
		expect(attentionSchema).toMatchObject({
			title: "Agency attention report v1",
			properties: { version: { const: 1 } },
		})
		expect(attentionSchema.$defs.signalKind.enum).toEqual([
			...AttentionSignalKind.literals,
		])
		expect(attentionSchema.$defs.signal.properties.actions.items.$ref).toBe(
			actionSchema.$id,
		)
	})
})
