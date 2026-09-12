import { Effect } from "effect"
import type { GraphNode } from "../graph-schema"
import type { BaseCommandOptions } from "../utils/command"
import type { ActionPrompts } from "./act-prompts"
import { archive } from "./archive"
import { repo } from "./repo"
import { task } from "./task"
import { phase } from "./phase"
import { sync } from "./sync"
import { status } from "./status"
import { pr, prCreate } from "./pr"
import { work as startWork, type StartWork } from "./work"

export type ActEntity = Extract<
	GraphNode,
	{ readonly kind: "epic" | "task" | "phase" }
>
type NativeOperation =
	| ReturnType<typeof task>
	| ReturnType<typeof phase>
	| ReturnType<typeof repo>
	| ReturnType<typeof sync>
	| ReturnType<typeof status>
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
	readonly preview: Plan
	readonly prepare: (prompts: ActionPrompts) => Effect.Effect<Plan, Error>
}

// A typed argument builder is used for both discovery and execution. Prompts are
// ordinary TypeScript; discovery does not expose or interpret form instructions.
const action = <A>(
	details: Details,
	example: A,
	read: (p: ActionPrompts) => Effect.Effect<A, Error>,
	build: (args: A) => Plan,
): ActAction => ({
	...details,
	preview: build(example),
	prepare: (p) => Effect.map(read(p), build),
})
const immediate = (details: Details, plan: Plan): ActAction => ({
	...details,
	preview: plan,
	prepare: () => Effect.succeed(plan),
})
const input = (id: string, label: string, option?: string): Input => ({
	id,
	label,
	required: !option,
	...(option ? { option } : {}),
})
const taskTarget = (node: ActEntity) =>
	node.kind === "phase"
		? { taskId: node.key.split("/")[0]!, phaseId: node.key.split("/")[1]! }
		: { taskId: node.key }

export const actionGroups = [
	{
		id: "repository",
		label: "Add a repository",
		actions: ["repo-add", "repo-link"],
	},
	{
		id: "create",
		label: "Create a task",
		actions: ["task-create", "investigation-create"],
	},
	{ id: "split", label: "Split a task / add a phase", actions: ["split"] },
	{ id: "work", label: "Work on a task or phase", actions: ["work"] },
	{
		id: "handoff",
		label: "Turn investigation into implementation",
		actions: ["handoff"],
	},
	{
		id: "review",
		label: "Review someone else's work",
		actions: ["review", "review-ref"],
	},
	{
		id: "close",
		label: "Close or reopen work",
		actions: ["complete", "drop", "sync", "reopen"],
	},
	{
		id: "pull-request",
		label: "Update pull-request status",
		actions: ["sync", "pr", "pr-ready", "pr-close"],
	},
	{ id: "archive", label: "Archive finished work", actions: ["archive"] },
	{ id: "current-work", label: "See current work", actions: ["current-work"] },
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
			...([false, true] as const).map((investigation) =>
				action(
					{
						id: investigation ? "investigation-create" : "task-create",
						label: investigation
							? "Create an investigation"
							: "Create a standard task",
						blockedReason: needsRepository,
						inputs: [
							input("id", "Task ID"),
							input("description", "Outcome"),
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
								repo: yield* p.repository(),
								base: yield* p.text("Base branch", "main"),
							}
						}),
					(args) => ({
						command: [
							"agency",
							"task",
							"create",
							args.id,
							"--repo",
							args.repo,
							"--base",
							args.base,
							"--description",
							args.description,
							...(investigation ? ["--purpose", "investigation"] : []),
						],
						run: task({
							...options,
							subcommand: "create",
							args: [args.id],
							...args,
							purpose: investigation ? "investigation" : undefined,
						}),
						next: { taskId: args.id },
					}),
				),
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
							input("id", "Review task ID"),
							input("repo", "Repository alias"),
							input(
								"source",
								sourceType === "ref" ? "Remote ref" : "PR URL or number",
							),
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
					input("dependsOn", "Completion dependency", "--depends-on"),
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
				inputs: [input("summary", "Completed outcome summary")],
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
	]
}

export const actionOutput = (action: ActAction, auto?: boolean) => {
	const { id, label, blockedReason, preview, inputs = [] } = action
	return {
		id,
		label,
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
