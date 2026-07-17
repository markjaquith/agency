import { Schema } from "@effect/schema"
import {
	EpicFrontmatter,
	PhaseFrontmatter,
	TaskFrontmatter,
	WorkStatus,
} from "./workbase/schemas"

export const GRAPH_VERSION = 1 as const

export const GraphNodeKind = Schema.Literal(
	"epic",
	"task",
	"phase",
	"repository",
	"execution-unit",
)

export const GraphEdgeKind = Schema.Literal(
	"owns",
	"depends_on",
	"writes",
	"references",
)

export const GraphInclude = Schema.Literal("bodies", "workspace", "git", "pr")

export const GraphBlocker = Schema.Struct({
	kind: Schema.Literal("dependency", "validation", "status"),
	id: Schema.String,
	status: Schema.optional(WorkStatus),
	reason: Schema.String,
})

export const GraphProgress = Schema.Struct({
	status: WorkStatus,
	total: Schema.Number,
	open: Schema.Number,
	working: Schema.Number,
	delegated: Schema.Number,
	done: Schema.Number,
	dropped: Schema.Number,
	terminal: Schema.Number,
})

export const GraphReadiness = Schema.Struct({
	ready: Schema.Boolean,
	blocked: Schema.Boolean,
	blockedBy: Schema.Array(Schema.String),
	terminal: Schema.Boolean,
	blockers: Schema.Array(GraphBlocker),
})

export const GraphWorkbase = Schema.Struct({
	version: Schema.Literal(2),
	root: Schema.optional(Schema.String),
})

export const GraphFilters = Schema.Struct({
	ready: Schema.NullOr(Schema.Boolean),
	blocked: Schema.NullOr(Schema.Boolean),
	statuses: Schema.Array(WorkStatus),
	repositories: Schema.Array(Schema.String),
	kinds: Schema.Array(GraphNodeKind),
})

const DocumentHash = Schema.Struct({ sha256: Schema.String })
export const GraphEpicData = Schema.extend(EpicFrontmatter, DocumentHash)
export const GraphTaskData = Schema.extend(TaskFrontmatter, DocumentHash)
export const GraphPhaseData = Schema.extend(PhaseFrontmatter, DocumentHash)
export const GraphExecutionData = Schema.extend(
	PhaseFrontmatter,
	Schema.Struct({
		taskId: Schema.String,
		phaseId: Schema.optional(Schema.String),
		ticketUrl: Schema.optional(Schema.NullOr(Schema.String)),
		epic: Schema.optional(Schema.String),
	}),
)

export const GraphDocumentWorkspace = Schema.Struct({
	documentPath: Schema.String,
	directory: Schema.String,
})
export const GraphRepositoryWorkspace = Schema.Struct({
	path: Schema.String,
	target: Schema.NullOr(Schema.String),
})
export const GraphExecutionWorkspace = Schema.Struct({
	codePath: Schema.String,
	checkoutPath: Schema.String,
	materialized: Schema.Boolean,
})
export const GraphRepositoryGit = Schema.Struct({
	kind: Schema.NullOr(Schema.Literal("bare", "repository")),
	remote: Schema.NullOr(Schema.String),
	head: Schema.NullOr(Schema.String),
	branch: Schema.NullOr(Schema.String),
})
export const GraphExecutionGit = Schema.Struct({
	branch: Schema.String,
	base: Schema.String,
	branchCommit: Schema.NullOr(Schema.String),
	baseCommit: Schema.NullOr(Schema.String),
	checkoutCommit: Schema.NullOr(Schema.String),
	checkoutBranch: Schema.NullOr(Schema.String),
	dirty: Schema.NullOr(Schema.Boolean),
})
export const GraphPr = Schema.Union(
	Schema.Struct({ url: Schema.Null, state: Schema.Literal("none") }),
	Schema.Struct({ url: Schema.String, state: Schema.Literal("unavailable") }),
	Schema.Struct({
		recordedUrl: Schema.String,
		number: Schema.Number,
		state: Schema.String,
		title: Schema.String,
		isDraft: Schema.Boolean,
		headRefName: Schema.String,
		baseRefName: Schema.String,
		url: Schema.String,
	}),
)

const NodeIdentity = {
	id: Schema.String,
	key: Schema.String,
	dependents: Schema.Array(Schema.String),
	repositories: Schema.Array(Schema.String),
}
const StatefulNode = {
	...NodeIdentity,
	status: WorkStatus,
	readiness: GraphReadiness,
	aggregate: GraphProgress,
}
const DocumentNode = {
	...StatefulNode,
	body: Schema.optional(Schema.String),
	workspace: Schema.optional(GraphDocumentWorkspace),
}

export const GraphNode = Schema.Union(
	Schema.Struct({
		...DocumentNode,
		kind: Schema.Literal("epic"),
		data: GraphEpicData,
	}),
	Schema.Struct({
		...DocumentNode,
		kind: Schema.Literal("task"),
		data: GraphTaskData,
	}),
	Schema.Struct({
		...DocumentNode,
		kind: Schema.Literal("phase"),
		data: GraphPhaseData,
	}),
	Schema.Struct({
		...NodeIdentity,
		kind: Schema.Literal("repository"),
		status: Schema.Null,
		readiness: Schema.Null,
		aggregate: Schema.Null,
		data: Schema.Struct({ alias: Schema.String }),
		workspace: Schema.optional(GraphRepositoryWorkspace),
		git: Schema.optional(GraphRepositoryGit),
	}),
	Schema.Struct({
		...StatefulNode,
		kind: Schema.Literal("execution-unit"),
		data: GraphExecutionData,
		workspace: Schema.optional(GraphExecutionWorkspace),
		git: Schema.optional(GraphExecutionGit),
		pr: Schema.optional(GraphPr),
	}),
)

export const GraphEdge = Schema.Struct({
	id: Schema.String,
	kind: GraphEdgeKind,
	from: Schema.String,
	to: Schema.String,
})

export const AgencyGraph = Schema.Struct({
	version: Schema.Literal(GRAPH_VERSION),
	workbase: GraphWorkbase,
	filters: GraphFilters,
	includes: Schema.Array(GraphInclude),
	nodes: Schema.Array(GraphNode),
	edges: Schema.Array(GraphEdge),
	summary: GraphProgress,
	validation: Schema.Struct({
		valid: Schema.Boolean,
		issues: Schema.Array(
			Schema.Struct({ path: Schema.String, message: Schema.String }),
		),
	}),
})

export type GraphNodeKind = Schema.Schema.Type<typeof GraphNodeKind>
export type GraphEdgeKind = Schema.Schema.Type<typeof GraphEdgeKind>
export type GraphInclude = Schema.Schema.Type<typeof GraphInclude>
export type GraphBlocker = Schema.Schema.Type<typeof GraphBlocker>
export type GraphProgress = Schema.Schema.Type<typeof GraphProgress>
export type GraphReadiness = Schema.Schema.Type<typeof GraphReadiness>
export type GraphExecutionWorkspace = Schema.Schema.Type<
	typeof GraphExecutionWorkspace
>
export type GraphExecutionGit = Schema.Schema.Type<typeof GraphExecutionGit>
export type GraphRepositoryGit = Schema.Schema.Type<typeof GraphRepositoryGit>
export type GraphPr = Schema.Schema.Type<typeof GraphPr>
export type GraphNode = Schema.Schema.Type<typeof GraphNode>
export type GraphEdge = Schema.Schema.Type<typeof GraphEdge>
export type AgencyGraph = Schema.Schema.Type<typeof AgencyGraph>

export type GraphJsonlRecord =
	| {
			readonly version: typeof GRAPH_VERSION
			readonly type: "meta"
			readonly graph: Omit<AgencyGraph, "nodes" | "edges">
	  }
	| {
			readonly version: typeof GRAPH_VERSION
			readonly type: "node"
			readonly node: GraphNode
	  }
	| {
			readonly version: typeof GRAPH_VERSION
			readonly type: "edge"
			readonly edge: GraphEdge
	  }
	| {
			readonly version: typeof GRAPH_VERSION
			readonly type: "end"
			readonly nodeCount: number
			readonly edgeCount: number
	  }

export function* graphJsonlRecords(
	graph: AgencyGraph,
): Generator<GraphJsonlRecord> {
	const { nodes, edges, ...metadata } = graph
	yield { version: GRAPH_VERSION, type: "meta", graph: metadata }
	for (const node of nodes) {
		yield { version: GRAPH_VERSION, type: "node", node }
	}
	for (const edge of edges) {
		yield { version: GRAPH_VERSION, type: "edge", edge }
	}
	yield {
		version: GRAPH_VERSION,
		type: "end",
		nodeCount: nodes.length,
		edgeCount: edges.length,
	}
}
