import { describe, expect, test } from "bun:test"
import { Schema } from "@effect/schema"
import jsonSchema from "../schemas/agency-graph-v1.schema.json"
import { AgencyGraph, graphJsonlRecords } from "./graph-schema"

describe("graph contract", () => {
	test("publishes the v1 JSON Schema", () => {
		expect(jsonSchema).toMatchObject({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			title: "Agency workbase graph v1",
			properties: { version: { const: 1 } },
		})
		expect(jsonSchema.properties.filters).toMatchObject({
			additionalProperties: false,
			required: ["ready", "blocked", "statuses", "repositories", "kinds"],
		})
		expect(jsonSchema.$defs.node.allOf).toHaveLength(5)
		expect(jsonSchema.$defs.readiness.required).toEqual([
			"ready",
			"blocked",
			"blockedBy",
			"terminal",
			"blockers",
		])
		expect(jsonSchema.$defs.node.allOf[3]?.then?.properties).toMatchObject({
			status: { type: "null" },
			readiness: { type: "null" },
			aggregate: { type: "null" },
		})
	})

	test("streams records that reconstruct graph semantics", () => {
		const nodes = [
			{
				id: "repository:agency",
				key: "agency",
				kind: "repository" as const,
				dependents: ["repository:effect"],
				repositories: ["agency"],
				status: null,
				readiness: null,
				aggregate: null,
				data: { alias: "agency" },
			},
			{
				id: "repository:effect",
				key: "effect",
				kind: "repository" as const,
				dependents: [],
				repositories: ["effect"],
				status: null,
				readiness: null,
				aggregate: null,
				data: { alias: "effect" },
			},
		]
		const edges = [
			{
				id: "references:repository:agency:repository:effect",
				kind: "references" as const,
				from: "repository:agency",
				to: "repository:effect",
			},
		]
		const graph = {
			version: 1,
			workbase: { version: 2 },
			filters: {
				ready: null,
				blocked: null,
				statuses: [],
				repositories: [],
				kinds: [],
			},
			includes: [],
			nodes,
			edges,
			summary: {
				status: "open",
				total: 0,
				open: 0,
				working: 0,
				delegated: 0,
				done: 0,
				dropped: 0,
				terminal: 0,
			},
			validation: { valid: true, issues: [] },
		} satisfies AgencyGraph
		expect(
			Schema.decodeUnknownSync(AgencyGraph, { onExcessProperty: "error" })(
				graph,
			),
		).toEqual(graph)
		const records = [...graphJsonlRecords(graph)]
		const { nodes: _nodes, edges: _edges, ...metadata } = graph
		expect(records).toEqual([
			{
				version: 1,
				type: "meta",
				graph: metadata,
			},
			...nodes.map((node) => ({
				version: 1 as const,
				type: "node" as const,
				node,
			})),
			...edges.map((edge) => ({
				version: 1 as const,
				type: "edge" as const,
				edge,
			})),
			{ version: 1, type: "end", nodeCount: 2, edgeCount: 1 },
		])
	})
})
