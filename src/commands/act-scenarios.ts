import { Effect } from "effect"
import type { GraphNode } from "../graph-schema"
import type { BaseCommandOptions } from "../utils/command"
import { repo } from "./repo"
import { task } from "./task"
import { phase } from "./phase"
import { sync } from "./sync"
import { status } from "./status"
import { pr } from "./pr"

type Entity = Extract<GraphNode, { readonly kind: "epic" | "task" | "phase" }>
type Values = Readonly<Record<string, string>>
interface Input {
	readonly id: string
	readonly label: string
	readonly required: boolean
	readonly default?: string
	readonly choices?: readonly string[]
	readonly slugFrom?: string
	readonly defaultTemplate?: string
}
const input = (
	id: string,
	label: string,
	required = true,
	value?: string,
): Input => ({ id, label, required, default: value })

// Shared by guided input and discovery; existing lifecycle services own mutations.
export const scenarios = (node?: Entity, purpose?: string, all = false) => {
	const taskId =
		node?.kind === "phase" ? node.key.split("/")[0]! : (node?.key ?? "")
	const phaseId = node?.kind === "phase" ? node.key.split("/")[1] : undefined
	const args = [taskId, ...(phaseId ? [phaseId] : [])]
	const execution =
		node &&
		node.kind !== "epic" &&
		!(node.kind === "task" && "phases" in node.data)
	const terminal = node?.status === "done" || node?.status === "dropped"
	const recordedPr = node && "pr" in node.data ? node.data.pr : null
	const prUrl = typeof recordedPr === "string" ? recordedPr : recordedPr?.url
	const revision = node?.data.sha256 ?? ""
	const repositoryInputs = [
		input(
			"repo",
			"Repository alias",
			true,
			node && "repo" in node.data ? node.data.repo : undefined,
		),
		input(
			"base",
			"Base branch",
			true,
			node && "base" in node.data ? node.data.base : "main",
		),
	]
	const definitions = [
		{
			id: "repo-add",
			label: "Add a repository from a remote",
			scope: "workbase",
			reason: null,
			inputs: [
				input("alias", "New repository alias"),
				input("remote", "Repository remote URL"),
			],
			command: (v: Values) => ["agency", "repo", "add", v.alias!, v.remote!],
			run: (v: Values, o: BaseCommandOptions) =>
				repo({ ...o, subcommand: "add", args: [v.alias!, v.remote!] }),
		},
		{
			id: "repo-link",
			label: "Link an existing local repository",
			scope: "workbase",
			reason: null,
			inputs: [
				input("alias", "Repository alias"),
				input("path", "Local repository path"),
			],
			command: (v: Values) => ["agency", "repo", "link", v.alias!, v.path!],
			run: (v: Values, o: BaseCommandOptions) =>
				repo({ ...o, subcommand: "link", args: [v.alias!, v.path!] }),
		},
		{
			id: "task-create",
			label: "Create a task",
			scope: "workbase",
			reason: null,
			inputs: [
				input("description", "Outcome"),
				{ ...input("id", "New task ID"), slugFrom: "description" },
				...repositoryInputs,
				{
					...input("purpose", "Task type", false, "standard"),
					choices: ["standard", "investigation"],
					omitWhen: "standard",
				},
			],
			nextTarget: (v: Values) => ({ taskId: v.id! }),
			command: (v: Values) => [
				"agency",
				"task",
				"create",
				v.id!,
				"--repo",
				v.repo!,
				"--base",
				v.base!,
				"--description",
				v.description!,
				...(v.purpose && v.purpose !== "standard"
					? ["--purpose", v.purpose]
					: []),
			],
			run: (v: Values, o: BaseCommandOptions) =>
				task({
					...o,
					subcommand: "create",
					args: [v.id!],
					repo: v.repo,
					base: v.base,
					description: v.description,
					purpose: v.purpose === "standard" ? undefined : v.purpose,
				}),
		},
		{
			id: "review",
			label: "Review someone else's work",
			scope: "workbase",
			reason: null,
			inputs: [
				input("repo", "Repository alias"),
				input("pullRequest", "Pull request URL or number"),
				{ ...input("id", "New review task ID"), slugFrom: "pullRequest" },
			],
			nextTarget: (v: Values) => ({ taskId: v.id! }),
			command: (v: Values) => [
				"agency",
				"task",
				"create",
				v.id!,
				"--review",
				v.repo!,
				"--pull-request",
				v.pullRequest!,
			],
			run: (v: Values, o: BaseCommandOptions) =>
				task({
					...o,
					subcommand: "create",
					args: [v.id!],
					review: v.repo,
					pullRequest: v.pullRequest,
				}),
		},
		{
			id: "current-work",
			label: "See current work",
			scope: "workbase",
			reason: null,
			inputs: [],
			command: () => ["agency", "status", "--status", "working"],
			run: (_v: Values, o: BaseCommandOptions) =>
				status({ ...o, statuses: ["working"] }),
		},
		{
			id: "review-ref",
			label: "Review a remote branch or commit",
			scope: "workbase",
			reason: null,
			inputs: [
				input("repo", "Repository alias"),
				input("ref", "Remote branch or commit", true, "main"),
				{
					...input("id", "New review task ID"),
					defaultTemplate: "review-<ref>",
				},
			],
			nextTarget: (v: Values) => ({ taskId: v.id! }),
			command: (v: Values) => [
				"agency",
				"task",
				"create",
				v.id!,
				"--review",
				v.repo!,
				"--ref",
				v.ref!,
			],
			run: (v: Values, o: BaseCommandOptions) =>
				task({
					...o,
					subcommand: "create",
					args: [v.id!],
					review: v.repo,
					ref: v.ref,
				}),
		},
		{
			id: "split",
			label: "Add a phase / split this task",
			scope: "item",
			reason:
				!node || node.kind !== "task"
					? "Select a task"
					: "review" in node.data
						? "Review tasks cannot be split into execution phases"
						: terminal
							? "Task is terminal"
							: null,
			inputs: [
				input(
					"id",
					"New phase ID",
					true,
					node?.kind === "task" && "phases" in node.data
						? `phase-${node.data.phases.length + 1}`
						: "next",
				),
				...(node?.kind === "task" && !("phases" in node.data)
					? [
							input(
								"firstPhase",
								"Name for the existing work's first phase",
								true,
								"initial",
							),
						]
					: []),
				...repositoryInputs,
				{
					...input("branch", "New phase branch"),
					defaultTemplate: `task/${taskId}-<id>`,
				},
				input(
					"dependsOn",
					"Wait for phase (optional; independent of base branch)",
					false,
				),
			],
			nextTarget: (v: Values) => ({ taskId, phaseId: v.id! }),
			command: (v: Values) => [
				"agency",
				"phase",
				"create",
				taskId,
				v.id!,
				"--repo",
				v.repo!,
				"--base",
				v.base!,
				"--branch",
				v.branch!,
				...(v.firstPhase ? ["--first-phase", v.firstPhase] : []),
				...(v.dependsOn ? ["--depends-on", v.dependsOn] : []),
			],
			run: (v: Values, o: BaseCommandOptions) =>
				phase({
					...o,
					subcommand: "create",
					args: [taskId, v.id!],
					repo: v.repo,
					base: v.base,
					branch: v.branch,
					firstPhase: v.firstPhase,
					dependsOn: v.dependsOn ? [v.dependsOn] : undefined,
				}),
		},
		{
			id: "handoff",
			label: "Create implementation follow-up",
			scope: "item",
			reason:
				!execution ||
				(purpose ??
					("purpose" in node!.data ? node!.data.purpose : undefined)) !==
					"investigation"
					? "Select an investigation execution unit"
					: null,
			inputs: [
				input(
					"id",
					"New implementation task ID",
					true,
					`${taskId}-implementation`,
				),
				...repositoryInputs,
			],
			nextTarget: (v: Values) => ({ taskId: v.id! }),
			command: (v: Values) => [
				"agency",
				"task",
				"handoff",
				taskId,
				v.id!,
				"--repo",
				v.repo!,
				"--base",
				v.base!,
				...(phaseId ? ["--source-phase", phaseId] : []),
			],
			run: (v: Values, o: BaseCommandOptions) =>
				task({
					...o,
					subcommand: "handoff",
					args: [taskId, v.id!],
					sourcePhase: phaseId,
					repo: v.repo,
					base: v.base,
				}),
		},
		{
			id: "complete",
			label: "Complete without a pull request",
			scope: "item",
			reason: !execution
				? "Select an execution unit"
				: terminal
					? "Item is already terminal"
					: prUrl
						? "Reconcile the recorded pull request instead"
						: null,
			inputs: [input("summary", "Completed non-PR outcome summary")],
			command: (v: Values) => [
				"agency",
				phaseId ? "phase" : "task",
				"status",
				...args,
				"done",
				"--if-revision",
				revision,
				"--no-pull-request",
				"--summary",
				v.summary!,
			],
			run: (v: Values, o: BaseCommandOptions) =>
				phaseId
					? phase({
							...o,
							subcommand: "status",
							args: [...args, "done"],
							ifRevision: revision,
							noPullRequest: true,
							summary: v.summary,
						})
					: task({
							...o,
							subcommand: "status",
							args: [...args, "done"],
							ifRevision: revision,
							noPullRequest: true,
							summary: v.summary,
						}),
		},
		{
			id: "sync",
			label: "Refresh Agency state from GitHub / provider",
			scope: "item",
			reason: !node || node.kind === "epic" ? "Select a task or phase" : null,
			inputs: [],
			command: () => ["agency", "sync", ...args],
			run: (_v: Values, o: BaseCommandOptions) =>
				sync({ ...o, taskId, phaseId }),
		},
		...(["ready", "close"] as const).map((operation) => ({
			id: `pr-${operation}`,
			label:
				operation === "ready"
					? "Mark GitHub PR ready for review"
					: "Close GitHub PR",
			scope: "item",
			reason:
				!prUrl || !/^https:\/\/github\.com\//.test(prUrl)
					? "Requires a recorded GitHub pull request URL"
					: null,
			inputs: [],
			command: () => ["agency", "pr", operation, prUrl ?? "<pull-request-url>"],
			followUpCommands: [["agency", "sync", ...args]],
			run: (_v: Values, o: BaseCommandOptions) =>
				Effect.gen(function* () {
					const code = yield* pr([operation, prUrl!], o.cwd)
					if (code !== 0)
						return yield* Effect.fail(
							new Error(`GitHub PR ${operation} failed (${code})`),
						)
					yield* sync({ ...o, taskId, phaseId })
				}),
		})),
	]
	const validation = node?.readiness.blockers.find(
		(blocker) => blocker.kind === "validation",
	)
	return definitions
		.filter(
			(definition) =>
				all ||
				(node ? definition.scope === "item" : definition.scope === "workbase"),
		)
		.map((definition) => ({
			...definition,
			reason: validation?.reason ?? definition.reason,
		}))
}

export const scenarioOutput = (
	scenario: ReturnType<typeof scenarios>[number],
	auto = false,
) => {
	const values = Object.fromEntries(
		scenario.inputs.map((field) => [field.id, `<${field.id}>`]),
	)
	const next =
		"nextTarget" in scenario ? scenario.nextTarget?.(values) : undefined
	return {
		id: scenario.id,
		label: scenario.label,
		available: scenario.reason === null,
		blockedReason: scenario.reason,
		inputs: scenario.inputs,
		command:
			scenario.inputs.length || scenario.reason
				? null
				: scenario.command(values),
		commandTemplate: scenario.inputs.length
			? scenario.command(values)
			: undefined,
		followUpCommands:
			"followUpCommands" in scenario ? scenario.followUpCommands : [],
		nextActions: next
			? [
					{
						id: "work",
						requiresSelection: true,
						commandTemplate: [
							"agency",
							"work",
							"--task",
							next.taskId,
							...("phaseId" in next ? ["--phase", next.phaseId] : []),
							...(auto ? ["--auto"] : []),
						],
					},
				]
			: [],
	}
}
