import { Effect } from "effect"
import { join } from "node:path"
import type { GraphNode } from "../graph-schema"
import type { BaseCommandOptions } from "../utils/command"
import type { ActionPrompts } from "./act-prompts"
import { archive } from "./archive"
import { doctor } from "./doctor"
import { epic } from "./epic"
import { integration } from "./integration"
import { repo } from "./repo"
import { review } from "./review"
import { task } from "./task"
import { phase } from "./phase"
import { push } from "./push"
import { sync } from "./sync"
import { status } from "./status"
import { pr, prCreate } from "./pr"
import { validate } from "./validate"
import { work as startWork, type StartWork } from "./work"
import { macchiato } from "../utils/theme"

export type ActEntity = Extract<
	GraphNode,
	{ readonly kind: "epic" | "task" | "phase" }
>
type NativeOperation =
	| ReturnType<typeof task>
	| ReturnType<typeof phase>
	| ReturnType<typeof epic>
	| ReturnType<typeof repo>
	| ReturnType<typeof review>
	| ReturnType<typeof push>
	| ReturnType<typeof sync>
	| ReturnType<typeof status>
	| ReturnType<typeof doctor>
	| ReturnType<typeof integration>
	| ReturnType<typeof validate>
	| ReturnType<typeof prCreate>
	| ReturnType<typeof archive>
	| ReturnType<StartWork>
type Operation = Effect.Effect<
	unknown,
	Effect.Effect.Error<NativeOperation>,
	Effect.Effect.Context<NativeOperation>
>
interface Plan {
	readonly command: readonly string[]
	readonly run: Operation
	readonly followUpCommands?: readonly (readonly string[])[]
	readonly next?: { readonly taskId: string; readonly phaseId?: string }
}
interface Input {
	readonly id: string
	readonly label: string
	readonly required: boolean
	readonly multiline?: boolean
	/** An optional input is appended as this native CLI option. */
	readonly option?: string
}
interface Details {
	readonly id: string
	readonly label: string
	readonly blockedReason: string | null
	readonly inputs?: readonly Input[]
}
export interface ActAction extends Details {
	readonly description: string
	readonly icon: string
	readonly color: string
	readonly preview: Plan
	/** Replayable input collection. All mutations belong in the returned plan.run. */
	readonly prepare: (prompts: ActionPrompts) => Effect.Effect<Plan, Error>
}

const actionPresentation: Record<
	string,
	{
		readonly description: string
		readonly icon: string
		readonly color: string
	}
> = {
	"repo-add": {
		description: "Clone a remote repository into this workbase.",
		icon: "󰐕",
		color: macchiato.green,
	},
	"repo-link": {
		description: "Use an existing local checkout as a repository alias.",
		icon: "󰌷",
		color: macchiato.sapphire,
	},
	"repo-setup": {
		description: "Materialize all portable repository declarations.",
		icon: "󰋊",
		color: macchiato.blue,
	},
	"repo-materialize": {
		description: "Replace a linked alias with a managed bare clone.",
		icon: "󰆧",
		color: macchiato.blue,
	},
	"repo-fetch": {
		description: "Fetch and prune a repository alias.",
		icon: "󰑐",
		color: macchiato.sapphire,
	},
	"repo-verify": {
		description: "Check that a repository alias is operational.",
		icon: "󰄬",
		color: macchiato.green,
	},
	"repo-rename": {
		description: "Rename an unused repository alias.",
		icon: "󰑕",
		color: macchiato.yellow,
	},
	"repo-remote": {
		description: "Update an alias's portable remote declaration.",
		icon: "󰛳",
		color: macchiato.sapphire,
	},
	"repo-unlink": {
		description: "Remove only this machine's linked checkout.",
		icon: "󰌺",
		color: macchiato.red,
	},
	"repo-remove": {
		description: "Remove an unused alias and its local materialization.",
		icon: "󰆴",
		color: macchiato.red,
	},
	"task-create": {
		description: "Create one deliverable execution task.",
		icon: "󰐕",
		color: macchiato.green,
	},
	"multi-phase-create": {
		description: "Create a task that will be delivered through phases.",
		icon: "",
		color: macchiato.yellow,
	},
	"investigation-create": {
		description: "Create evidence-gathering work before implementation.",
		icon: "󰍉",
		color: macchiato.mauve,
	},
	"epic-create": {
		description: "Create an epic to coordinate related tasks.",
		icon: "",
		color: macchiato.mauve,
	},
	"task-create-in-epic": {
		description: "Create a new execution task inside this epic.",
		icon: "󰐕",
		color: macchiato.green,
	},
	review: {
		description: "Create a task pinned to an existing pull request.",
		icon: "󰍉",
		color: macchiato.mauve,
	},
	"review-ref": {
		description: "Create a task pinned to a remote branch or commit.",
		icon: "󰓹",
		color: macchiato.mauve,
	},
	"current-work": {
		description: "Show tasks and phases currently being worked.",
		icon: "",
		color: macchiato.blue,
	},
	"ready-work": {
		description: "Show execution units that are ready to start.",
		icon: "󰄱",
		color: macchiato.green,
	},
	validate: {
		description: "Validate workbase documents and relationships.",
		icon: "󰄬",
		color: macchiato.green,
	},
	doctor: {
		description: "Diagnose workbase, repository, and integration health.",
		icon: "󰒡",
		color: macchiato.yellow,
	},
	"sync-all": {
		description: "Reconcile all work with repository and provider state.",
		icon: "󰑓",
		color: macchiato.sapphire,
	},
	"integration-status": {
		description: "Inspect managed agent integration files.",
		icon: "󰋼",
		color: macchiato.blue,
	},
	"integration-sync": {
		description: "Update safe managed agent integration files.",
		icon: "󰑐",
		color: macchiato.sapphire,
	},
	work: {
		description: "Prepare this item and start its configured worker.",
		icon: "",
		color: macchiato.green,
	},
	push: {
		description: "Validate and publish this execution branch without a PR.",
		icon: "󰜷",
		color: macchiato.sapphire,
	},
	pr: {
		description: "Publish this execution branch and record its pull request.",
		icon: "",
		color: macchiato.mauve,
	},
	"review-refresh": {
		description: "Fetch and repin this review task to its current source.",
		icon: "󰑐",
		color: macchiato.sapphire,
	},
	reopen: {
		description: "Return terminal work to open status.",
		icon: "󰑓",
		color: macchiato.sapphire,
	},
	drop: {
		description: "Abandon this item without satisfying dependents.",
		icon: "󰅖",
		color: macchiato.red,
	},
	archive: {
		description: "Move terminal work into the archive.",
		icon: "",
		color: macchiato.yellow,
	},
	split: {
		description: "Convert or extend this task with another delivery phase.",
		icon: "",
		color: macchiato.yellow,
	},
	handoff: {
		description: "Create distinct implementation work from this investigation.",
		icon: "",
		color: macchiato.mauve,
	},
	complete: {
		description: "Record a genuine non-PR outcome as complete.",
		icon: "󰄬",
		color: macchiato.green,
	},
	sync: {
		description: "Reconcile this item with repository and provider state.",
		icon: "󰑓",
		color: macchiato.sapphire,
	},
	"pr-ready": {
		description: "Mark this recorded GitHub pull request ready for review.",
		icon: "󰄬",
		color: macchiato.green,
	},
	"pr-close": {
		description: "Close this recorded GitHub pull request.",
		icon: "",
		color: macchiato.red,
	},
	rename: {
		description: "Rename this item and update durable references.",
		icon: "󰑕",
		color: macchiato.yellow,
	},
	"dependency-add": {
		description: "Require another sibling item to finish first.",
		icon: "󰌹",
		color: macchiato.yellow,
	},
	"dependency-remove": {
		description: "Remove a completion dependency from this item.",
		icon: "󰌺",
		color: macchiato.red,
	},
	"move-to-epic": {
		description: "Move this task into an existing epic.",
		icon: "󰉒",
		color: macchiato.mauve,
	},
	"remove-from-epic": {
		description: "Move this task out of its current epic.",
		icon: "󰉍",
		color: macchiato.yellow,
	},
}

export const isActActionId = (id: string): boolean =>
	Object.hasOwn(actionPresentation, id)

const present = (details: Details) => {
	const presentation = actionPresentation[details.id]
	if (!presentation)
		throw new Error(`Missing presentation for action '${details.id}'`)
	return { ...details, ...presentation }
}

// A typed argument builder is used for both discovery and execution. Prompts are
// ordinary TypeScript; discovery does not expose or interpret form instructions.
const action = <A>(
	details: Details,
	example: A,
	read: (p: ActionPrompts) => Effect.Effect<A, Error>,
	build: (args: A) => Plan,
): ActAction => ({
	...present(details),
	preview: build(example),
	prepare: (p) => Effect.map(read(p), build),
})
const immediate = (details: Details, plan: Plan): ActAction => ({
	...present(details),
	preview: plan,
	prepare: () => Effect.succeed(plan),
})
const input = (
	id: string,
	label: string,
	options: { option?: string; multiline?: boolean } = {},
): Input => ({
	id,
	label,
	required: !options.option,
	...options,
})
const taskTarget = (node: ActEntity) =>
	node.kind === "phase"
		? { taskId: node.key.split("/")[0]!, phaseId: node.key.split("/")[1]! }
		: { taskId: node.key }

export const actionGroups = [
	{
		id: "create",
		label: "Create work",
		icon: "󰐕",
		actions: [
			"task-create",
			"multi-phase-create",
			"investigation-create",
			"epic-create",
			"task-create-in-epic",
		],
	},
	{
		id: "work",
		label: "Work on a task or phase",
		icon: "",
		actions: ["work"],
	},
	{
		id: "review",
		label: "Review someone else's work",
		icon: "󰍉",
		actions: ["review", "review-ref"],
	},
	{
		id: "split",
		label: "Split a task / add a phase",
		icon: "",
		actions: ["split"],
	},
	{
		id: "handoff",
		label: "Turn investigation into implementation",
		icon: "",
		actions: ["handoff"],
	},
	{
		id: "current-work",
		label: "See work status",
		icon: "",
		actions: ["current-work", "ready-work"],
	},
	{
		id: "browse",
		label: "Browse items",
		icon: "",
		actions: [],
	},
	{
		id: "pull-request",
		label: "Publish or update a pull request",
		icon: "",
		actions: ["push", "sync", "pr", "pr-ready", "pr-close"],
	},
	{
		id: "archive",
		label: "Archive finished work",
		icon: "",
		actions: ["archive"],
	},
	{
		id: "repository",
		label: "Manage repositories",
		icon: "",
		actions: [
			"repo-add",
			"repo-link",
			"repo-setup",
			"repo-materialize",
			"repo-fetch",
			"repo-verify",
			"repo-rename",
			"repo-remote",
			"repo-unlink",
			"repo-remove",
		],
	},
	{
		id: "health",
		label: "Check or refresh the workbase",
		icon: "󰒡",
		actions: [
			"validate",
			"doctor",
			"sync-all",
			"integration-status",
			"integration-sync",
		],
	},
	{
		id: "organize",
		label: "Rename or change dependencies",
		icon: "󰙅",
		actions: [
			"rename",
			"move-to-epic",
			"remove-from-epic",
			"dependency-add",
			"dependency-remove",
		],
	},
] as const

export const actActions = (
	nodes: readonly GraphNode[],
	options: BaseCommandOptions & { auto?: boolean; draft?: boolean },
	work: StartWork = startWork,
	node?: ActEntity,
): readonly ActAction[] => {
	const repositories = nodes
		.filter((node) => node.kind === "repository")
		.map((node) => node.key)
	const needsRepository = repositories.length
		? null
		: "Add or link a repository first"
	if (!node)
		return [
			...(["add", "link"] as const).map((operation) =>
				action(
					{
						id: `repo-${operation}`,
						label:
							operation === "add"
								? "Add from a remote"
								: "Link a local repository",
						blockedReason: null,
						inputs: [
							input("alias", "Repository alias"),
							input(
								"source",
								operation === "add" ? "Remote URL" : "Local path",
							),
						],
					},
					{ alias: "<alias>", source: "<source>" },
					(p) =>
						Effect.gen(function* () {
							return {
								alias: yield* p.text("Repository alias"),
								source: yield* p.text(
									operation === "add"
										? "Repository remote URL"
										: "Local repository path",
								),
							}
						}),
					({ alias, source }) => ({
						command: ["agency", "repo", operation, alias, source],
						run: repo({
							...options,
							subcommand: operation,
							args: [alias, source],
						}),
					}),
				),
			),
			...(["standard", "multi-phase", "investigation"] as const).map((kind) =>
				action(
					{
						id:
							kind === "standard"
								? "task-create"
								: kind === "multi-phase"
									? "multi-phase-create"
									: "investigation-create",
						label:
							kind === "standard"
								? "Create a standard task"
								: kind === "multi-phase"
									? "Create a multi-phase task"
									: "Create an investigation",
						blockedReason: kind === "multi-phase" ? null : needsRepository,
						inputs: [
							input("description", "Outcome", { multiline: true }),
							input("id", "Task ID"),
							...(kind === "multi-phase"
								? []
								: [
										input("repo", "Repository alias"),
										input("base", "Base branch"),
									]),
						],
					},
					{
						id: "<id>",
						description: "<description>",
						repo: kind === "multi-phase" ? undefined : "<repo>",
						base: kind === "multi-phase" ? undefined : "<base>",
					},
					(p) =>
						Effect.gen(function* () {
							const description = yield* p.text("Outcome")
							return {
								description,
								id: yield* p.id("New task ID", description),
								repo:
									kind === "multi-phase" ? undefined : yield* p.repository(),
								base:
									kind === "multi-phase"
										? undefined
										: yield* p.text("Base branch", "main"),
							}
						}),
					(args) => ({
						command: [
							"agency",
							"task",
							"create",
							args.id,
							...(args.repo ? ["--repo", args.repo] : []),
							...(args.base ? ["--base", args.base] : []),
							"--description",
							args.description,
							...(kind === "multi-phase" ? ["--multi-phase"] : []),
							...(kind === "investigation"
								? ["--purpose", "investigation"]
								: []),
						],
						run: task({
							...options,
							subcommand: "create",
							args: [args.id],
							...args,
							multiPhase: kind === "multi-phase",
							purpose: kind === "investigation" ? "investigation" : undefined,
						}),
						next: { taskId: args.id },
					}),
				),
			),
			action(
				{
					id: "epic-create",
					label: "Create an epic",
					blockedReason: needsRepository,
					inputs: [
						input("description", "Outcome", { multiline: true }),
						input("id", "Epic ID"),
						input("ticketUrl", "Ticket URL"),
						input("repo", "Repository alias"),
						input("ref", "Repository ref"),
					],
				},
				{
					id: "<id>",
					description: "<description>",
					ticketUrl: "<ticketUrl>",
					repo: "<repo>",
					ref: "<ref>",
				},
				(p) =>
					Effect.gen(function* () {
						const description = yield* p.text("Outcome")
						return {
							description,
							id: yield* p.id("New epic ID", description),
							ticketUrl: yield* p.text("Ticket URL"),
							repo: yield* p.repository(),
							ref: yield* p.text("Repository ref", "main"),
						}
					}),
				(values) => ({
					command: [
						"agency",
						"epic",
						"create",
						values.id,
						"--ticket-url",
						values.ticketUrl,
						"--repo",
						`${values.repo}:${values.ref}`,
						"--description",
						values.description,
					],
					run: epic({
						...options,
						subcommand: "create",
						args: [values.id],
						ticketUrl: values.ticketUrl,
						repos: [`${values.repo}:${values.ref}`],
						description: values.description,
					}),
				}),
			),
			...(["pull-request", "ref"] as const).map((sourceType) =>
				action(
					{
						id: sourceType === "ref" ? "review-ref" : "review",
						label:
							sourceType === "ref"
								? "Review a branch or commit"
								: "Review a pull request",
						blockedReason: needsRepository,
						inputs: [
							input("repo", "Repository alias"),
							input(
								"source",
								sourceType === "ref" ? "Remote ref" : "PR URL or number",
							),
							input("id", "Review task ID"),
						],
					},
					{ id: "<id>", repo: "<repo>", source: "<source>" },
					(p) =>
						Effect.gen(function* () {
							const repo = yield* p.repository()
							const source = yield* p.text(
								sourceType === "ref"
									? "Remote branch or commit"
									: "Pull request URL or number",
								sourceType === "ref" ? "main" : "",
							)
							return {
								repo,
								source,
								id: yield* p.id(
									"New review task ID",
									`review-${source.split("/").pop()}`,
								),
							}
						}),
					({ id, repo, source }) => ({
						command: [
							"agency",
							"task",
							"create",
							id,
							"--review",
							repo,
							`--${sourceType}`,
							source,
						],
						run: task({
							...options,
							subcommand: "create",
							args: [id],
							review: repo,
							...(sourceType === "ref"
								? { ref: source }
								: { pullRequest: source }),
						}),
						next: { taskId: id },
					}),
				),
			),
			immediate(
				{
					id: "current-work",
					label: "See current work",
					blockedReason: null,
				},
				{
					command: ["agency", "status", "--status", "working"],
					run: status({ ...options, statuses: ["working"] }),
				},
			),
			immediate(
				{
					id: "ready-work",
					label: "See ready work",
					blockedReason: null,
				},
				{
					command: ["agency", "status", "--ready"],
					run: status({ ...options, ready: true }),
				},
			),
			immediate(
				{
					id: "repo-setup",
					label: "Set up declared repositories",
					blockedReason: null,
				},
				{
					command: ["agency", "repo", "setup", "--apply"],
					run: repo({ ...options, subcommand: "setup", args: [], apply: true }),
				},
			),
			...(["materialize", "fetch", "verify"] as const).map((operation) =>
				action(
					{
						id: `repo-${operation}`,
						label:
							operation === "materialize"
								? "Materialize a repository"
								: operation === "fetch"
									? "Fetch a repository"
									: "Verify a repository",
						blockedReason: needsRepository,
						inputs: [input("repo", "Repository alias")],
					},
					"<repo>",
					(p) => p.repository(),
					(alias) => ({
						command: ["agency", "repo", operation, alias],
						run: repo({ ...options, subcommand: operation, args: [alias] }),
					}),
				),
			),
			action(
				{
					id: "repo-rename",
					label: "Rename a repository alias",
					blockedReason: needsRepository,
					inputs: [
						input("repo", "Repository alias"),
						input("id", "New repository alias"),
					],
				},
				{ repo: "<repo>", id: "<id>" },
				(p) =>
					Effect.gen(function* () {
						return {
							repo: yield* p.repository(),
							id: yield* p.id("New repository alias", "repository"),
						}
					}),
				({ repo: alias, id }) => ({
					command: ["agency", "repo", "rename", alias, id],
					run: repo({
						...options,
						subcommand: "rename",
						args: [alias, id],
					}),
				}),
			),
			action(
				{
					id: "repo-remote",
					label: "Update a repository remote",
					blockedReason: needsRepository,
					inputs: [
						input("repo", "Repository alias"),
						input("remote", "Remote URL"),
					],
				},
				{ repo: "<repo>", remote: "<remote>" },
				(p) =>
					Effect.gen(function* () {
						return {
							repo: yield* p.repository(),
							remote: yield* p.text("Portable remote URL"),
						}
					}),
				({ repo: alias, remote }) => ({
					command: ["agency", "repo", "remote", alias, remote],
					run: repo({
						...options,
						subcommand: "remote",
						args: [alias, remote],
					}),
				}),
			),
			...(["unlink", "remove"] as const).map((operation) =>
				action(
					{
						id: `repo-${operation}`,
						label:
							operation === "unlink"
								? "Unlink a local repository"
								: "Remove a repository alias",
						blockedReason: needsRepository,
						inputs: [input("repo", "Repository alias")],
					},
					"<repo>",
					(p) => p.repository(),
					(alias) => ({
						command: ["agency", "repo", operation, alias],
						run: repo({ ...options, subcommand: operation, args: [alias] }),
					}),
				),
			),
			immediate(
				{ id: "validate", label: "Validate workbase", blockedReason: null },
				{
					command: ["agency", "validate"],
					run: validate(options),
				},
			),
			immediate(
				{ id: "doctor", label: "Diagnose workbase", blockedReason: null },
				{ command: ["agency", "doctor"], run: doctor(options) },
			),
			immediate(
				{
					id: "sync-all",
					label: "Refresh all Agency state",
					blockedReason: null,
				},
				{ command: ["agency", "sync"], run: sync(options) },
			),
			...(["status", "sync"] as const).map((operation) =>
				immediate(
					{
						id: `integration-${operation}`,
						label:
							operation === "status"
								? "Check agent integration"
								: "Update agent integration",
						blockedReason: null,
					},
					{
						command: ["agency", "integration", operation],
						run: integration({ ...options, subcommand: operation }),
					},
				),
			),
		]

	const target = taskTarget(node)
	const args = [target.taskId, ...(target.phaseId ? [target.phaseId] : [])]
	const execution = nodes.find(
		(candidate): candidate is Extract<GraphNode, { kind: "execution-unit" }> =>
			candidate.kind === "execution-unit" &&
			candidate.id === `execution-unit:${node.kind}/${node.key}`,
	)
	const parent = nodes.find(
		(candidate) => candidate.kind === "task" && candidate.key === target.taskId,
	)
	const purpose =
		parent && "purpose" in parent.data ? parent.data.purpose : undefined
	const terminal = node.status === "done" || node.status === "dropped"
	const blockers = (execution ?? node).readiness.blockers
	const validation = blockers.find(
		(blocker) => blocker.kind === "validation",
	)?.reason
	const dependency = blockers.find(
		(blocker) => blocker.kind === "dependency",
	)?.reason
	const recordedPr = "pr" in node.data ? node.data.pr : null
	const prUrl = typeof recordedPr === "string" ? recordedPr : recordedPr?.url
	const base = "base" in node.data ? node.data.base : "main"
	const preferredRepo = "repo" in node.data ? node.data.repo : undefined
	const details = (
		id: string,
		label: string,
		reason: string | null = null,
	): Details => ({
		id,
		label,
		blockedReason: validation ?? reason,
	})
	const noExecution = execution ? null : "Select an execution unit"
	const statusCommand = (status: string) => [
		"agency",
		target.phaseId ? "phase" : "task",
		"status",
		...args,
		status,
		"--if-revision",
		node.data.sha256,
	]
	const changeStatus = (status: string, summary?: string) => {
		const update = {
			...options,
			subcommand: "status",
			args: [...args, status],
			ifRevision: node.data.sha256,
			...(summary ? { noPullRequest: true, summary } : {}),
		}
		return target.phaseId ? phase(update) : task(update)
	}
	const workTarget = node.kind === "epic" ? { epicId: node.key } : target
	const itemDirectory = join(
		options.cwd ?? process.cwd(),
		node.kind === "epic"
			? `epics/${node.key}`
			: target.phaseId
				? `tasks/${target.taskId}/phases/${target.phaseId}`
				: `tasks/${target.taskId}`,
	)
	const canWork =
		node.readiness.ready ||
		Boolean(
			execution && node.status === "working" && !dependency && !validation,
		)
	return [
		immediate(
			details(
				"work",
				"Work on this item",
				canWork
					? null
					: blockers.map((blocker) => blocker.reason).join("; ") ||
							"Item is not ready for work",
			),
			{
				command: [
					"agency",
					"work",
					...(node.kind === "epic"
						? ["--epic", node.key]
						: [
								"--task",
								target.taskId,
								...(target.phaseId ? ["--phase", target.phaseId] : []),
							]),
					...(options.auto ? ["--auto"] : []),
				],
				run: Effect.suspend(() => work({ ...options, ...workTarget })),
			},
		),
		immediate(
			details(
				"push",
				"Publish branch without a pull request",
				noExecution ??
					(parent && "review" in parent.data
						? "Review tasks do not publish delivery branches"
						: node.status !== "working"
							? "Item must be working before publication"
							: null),
			),
			{
				command: ["agency", "--cwd", itemDirectory, "push"],
				run: push({ ...options, cwd: itemDirectory }),
			},
		),
		immediate(
			details(
				"pr",
				"Create pull request",
				noExecution ??
					(parent && "review" in parent.data
						? "Review tasks do not create delivery PRs"
						: purpose === "investigation"
							? "Create an implementation follow-up first"
							: terminal
								? "Item is terminal"
								: prUrl
									? "Item already has a recorded PR"
									: (dependency ?? null)),
			),
			{
				command: [
					"agency",
					"pr",
					"create",
					...args,
					...(options.draft ? ["--draft"] : []),
				],
				run: prCreate({ ...options, ...target }),
			},
		),
		immediate(
			details(
				"review-refresh",
				"Refresh review source",
				node.kind === "task" && "review" in node.data
					? null
					: "Select a review task",
			),
			{
				command: [
					"agency",
					"review",
					"refresh",
					target.taskId,
					"--if-revision",
					node.data.sha256,
				],
				run: review({
					...options,
					subcommand: "refresh",
					taskId: target.taskId,
					ifRevision: node.data.sha256,
				}),
			},
		),
		...(["reopen", "drop"] as const).map((id) => {
			const status = id === "reopen" ? "open" : "dropped"
			return immediate(
				details(
					id,
					id === "reopen" ? "Reopen" : "Drop",
					noExecution ??
						(id === "reopen"
							? terminal
								? null
								: "Item is not terminal"
							: terminal
								? "Item is already terminal"
								: null),
				),
				{ command: statusCommand(status), run: changeStatus(status) },
			)
		}),
		immediate(
			details(
				"archive",
				"Archive",
				node.readiness.terminal
					? null
					: "Item and all children must be terminal",
			),
			{
				command: ["agency", "archive", node.kind, ...args],
				run: archive({ ...options, type: node.kind, args }),
			},
		),
		action(
			{
				...details(
					"task-create-in-epic",
					"Create a task in this epic",
					node.kind === "epic" ? needsRepository : "Select an epic",
				),
				inputs: [
					input("description", "Outcome", { multiline: true }),
					input("id", "Task ID"),
					input("repo", "Repository alias"),
					input("base", "Base branch"),
				],
			},
			{
				id: "<id>",
				description: "<description>",
				repo: "<repo>",
				base: "<base>",
			},
			(p) =>
				Effect.gen(function* () {
					const description = yield* p.text("Outcome")
					return {
						description,
						id: yield* p.id("New task ID", description),
						repo: yield* p.repository(node.repositories[0]),
						base: yield* p.text("Base branch", "main"),
					}
				}),
			(values) => ({
				command: [
					"agency",
					"task",
					"create",
					values.id,
					"--epic",
					node.key,
					"--repo",
					values.repo,
					"--base",
					values.base,
					"--description",
					values.description,
				],
				run: task({
					...options,
					subcommand: "create",
					args: [values.id],
					epic: node.key,
					...values,
				}),
				next: { taskId: values.id },
			}),
		),
		action(
			{
				...details(
					"split",
					"Add a phase / split this task",
					node.kind !== "task"
						? "Select a task"
						: "review" in node.data
							? "Review tasks cannot be split into execution phases"
							: terminal
								? "Task is terminal"
								: null,
				),
				inputs: [
					input("id", "New phase ID"),
					...(node.kind === "task" && !("phases" in node.data)
						? [input("firstPhase", "Existing work's phase ID")]
						: []),
					input("repo", "Repository alias"),
					input("base", "Base branch"),
					input("branch", "New phase branch"),
					input("dependsOn", "Completion dependency", {
						option: "--depends-on",
					}),
				],
			},
			{
				id: "<id>",
				firstPhase:
					node.kind === "task" && !("phases" in node.data)
						? "<firstPhase>"
						: undefined,
				repo: "<repo>",
				base: "<base>",
				branch: "<branch>",
				dependsOn: "",
			},
			(p) =>
				Effect.gen(function* () {
					const id = yield* p.id(
						"New phase ID",
						"phases" in node.data
							? `phase-${node.data.phases.length + 1}`
							: "next",
						`${node.key}/`,
					)
					const firstPhase =
						"phases" in node.data
							? undefined
							: yield* p.text(
									"Name for the existing work's first phase",
									"initial",
								)
					return {
						id,
						firstPhase,
						repo: yield* p.repository(preferredRepo),
						base: yield* p.text("Base branch", base),
						branch: yield* p.text("New phase branch", `task/${node.key}-${id}`),
						dependsOn: yield* p.text(
							"Wait for phase (optional; independent of base branch)",
							"",
							false,
						),
					}
				}),
			(values) => ({
				command: [
					"agency",
					"phase",
					"create",
					target.taskId,
					values.id,
					"--repo",
					values.repo,
					"--base",
					values.base,
					"--branch",
					values.branch,
					...(values.firstPhase ? ["--first-phase", values.firstPhase] : []),
					...(values.dependsOn ? ["--depends-on", values.dependsOn] : []),
				],
				run: phase({
					...options,
					subcommand: "create",
					args: [target.taskId, values.id],
					...values,
					dependsOn: values.dependsOn ? [values.dependsOn] : undefined,
				}),
				next: { taskId: target.taskId, phaseId: values.id },
			}),
		),
		action(
			{
				...details(
					"handoff",
					"Create implementation follow-up",
					noExecution ??
						(purpose === "investigation"
							? null
							: "Select an investigation execution unit"),
				),
				inputs: [
					input("id", "New task ID"),
					input("repo", "Repository alias"),
					input("base", "Base branch"),
				],
			},
			{ id: "<id>", repo: "<repo>", base: "<base>" },
			(p) =>
				Effect.gen(function* () {
					return {
						id: yield* p.id(
							"New implementation task ID",
							`${target.taskId}-implementation`,
						),
						repo: yield* p.repository(preferredRepo),
						base: yield* p.text("Base branch", base),
					}
				}),
			(values) => ({
				command: [
					"agency",
					"task",
					"handoff",
					target.taskId,
					values.id,
					"--repo",
					values.repo,
					"--base",
					values.base,
					...(target.phaseId ? ["--source-phase", target.phaseId] : []),
				],
				run: task({
					...options,
					subcommand: "handoff",
					args: [target.taskId, values.id],
					...values,
					sourcePhase: target.phaseId,
				}),
				next: { taskId: values.id },
			}),
		),
		action(
			{
				...details(
					"complete",
					"Complete without a pull request",
					noExecution ??
						(terminal
							? "Item is already terminal"
							: prUrl
								? "Reconcile the recorded pull request instead"
								: null),
				),
				inputs: [
					input("summary", "Completed outcome summary", { multiline: true }),
				],
			},
			"<summary>",
			(p) => p.text("Completed non-PR outcome summary"),
			(summary) => ({
				command: [
					...statusCommand("done"),
					"--no-pull-request",
					"--summary",
					summary,
				],
				run: changeStatus("done", summary),
			}),
		),
		immediate(
			details(
				"sync",
				"Refresh Agency state from GitHub / provider",
				node.kind === "epic" ? "Select a task or phase" : null,
			),
			{
				command: ["agency", "sync", ...args],
				run: sync({ ...options, ...target }),
			},
		),
		...(["ready", "close"] as const).map((operation) =>
			immediate(
				details(
					`pr-${operation}`,
					operation === "ready"
						? "Mark GitHub PR ready for review"
						: "Close GitHub PR",
					prUrl?.startsWith("https://github.com/")
						? null
						: "Requires a recorded GitHub pull request URL",
				),
				{
					command: ["agency", "pr", operation, prUrl ?? "<pull-request-url>"],
					followUpCommands: [["agency", "sync", ...args]],
					run: Effect.gen(function* () {
						const code = yield* pr([operation, prUrl ?? ""], options.cwd)
						if (code !== 0)
							return yield* Effect.fail(
								new Error(`GitHub PR ${operation} failed (${code})`),
							)
						yield* sync({ ...options, ...target })
					}),
				},
			),
		),
		action(
			{
				...details("rename", "Rename item"),
				inputs: [input("id", "New item ID")],
			},
			"<id>",
			(p) =>
				p.id(
					`New ${node.kind} ID`,
					node.kind === "phase" ? target.phaseId! : node.key,
					node.kind === "phase" ? `${target.taskId}/` : "",
				),
			(id) => {
				const command = [
					"agency",
					node.kind,
					"rename",
					...(node.kind === "phase"
						? [target.taskId, target.phaseId!, id]
						: [node.key, id]),
					"--if-revision",
					node.data.sha256,
				]
				const update = {
					...options,
					subcommand: "rename",
					args:
						node.kind === "phase"
							? [target.taskId, target.phaseId!, id]
							: [node.key, id],
					ifRevision: node.data.sha256,
				}
				return {
					command,
					run:
						node.kind === "epic"
							? epic(update)
							: node.kind === "phase"
								? phase(update)
								: task(update),
				}
			},
		),
		action(
			{
				...details(
					"move-to-epic",
					"Move task to an epic",
					node.kind === "task" ? null : "Select a task",
				),
				inputs: [input("epic", "Epic ID")],
			},
			"<epic>",
			(p) => p.text("Destination epic ID"),
			(epicId) => ({
				command: [
					"agency",
					"task",
					"move",
					target.taskId,
					"--epic",
					epicId,
					"--if-revision",
					node.data.sha256,
				],
				run: task({
					...options,
					subcommand: "move",
					args: [target.taskId],
					epic: epicId,
					ifRevision: node.data.sha256,
				}),
			}),
		),
		immediate(
			details(
				"remove-from-epic",
				"Remove task from its epic",
				node.kind === "task" && node.data.epic
					? null
					: "Select a task that belongs to an epic",
			),
			{
				command: [
					"agency",
					"task",
					"move",
					target.taskId,
					"--no-epic",
					"--if-revision",
					node.data.sha256,
				],
				run: task({
					...options,
					subcommand: "move",
					args: [target.taskId],
					noEpic: true,
					ifRevision: node.data.sha256,
				}),
			},
		),
		...(["add", "remove"] as const).map((operation) =>
			action(
				{
					...details(
						`dependency-${operation}`,
						operation === "add" ? "Add dependency" : "Remove dependency",
						node.kind === "phase"
							? terminal
								? "Phase is terminal"
								: null
							: node.kind === "task" && node.data.epic
								? terminal
									? "Task is terminal"
									: null
								: "Select a phase or a task in an epic",
					),
					inputs: [input("dependency", "Dependency ID")],
				},
				"<dependency>",
				(p) =>
					p.text(`${operation === "add" ? "Required" : "Current"} sibling ID`),
				(dependency) => {
					const command = [
						"agency",
						node.kind === "phase" ? "phase" : "task",
						"dependency",
						operation,
						...args,
						dependency,
						"--if-revision",
						node.data.sha256,
					]
					const update = {
						...options,
						subcommand: "dependency",
						args: [operation, ...args, dependency],
						ifRevision: node.data.sha256,
					}
					return {
						command,
						run: node.kind === "phase" ? phase(update) : task(update),
					}
				},
			),
		),
	]
}

export const actionOutput = (action: ActAction, auto?: boolean) => {
	const {
		id,
		label,
		description,
		icon,
		color,
		blockedReason,
		preview,
		inputs = [],
	} = action
	return {
		id,
		label,
		description,
		icon,
		color,
		available: blockedReason === null,
		blockedReason,
		...(blockedReason
			? {}
			: {
					inputs,
					command: inputs.some((input) => input.required)
						? null
						: preview.command,
					...(inputs.length ? { commandTemplate: preview.command } : {}),
					...(preview.followUpCommands
						? { followUpCommands: preview.followUpCommands }
						: {}),
					...(preview.next
						? {
								nextActions: [
									{
										id: "work",
										requiresSelection: true,
										commandTemplate: [
											"agency",
											"work",
											"--task",
											preview.next.taskId,
											...(preview.next.phaseId
												? ["--phase", preview.next.phaseId]
												: []),
											...(auto ? ["--auto"] : []),
										],
									},
								],
							}
						: {}),
				}),
	}
}
