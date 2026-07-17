import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"
import { WorktreeService } from "../services/WorktreeService"

interface WorktreeOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args?: readonly string[]
}

const targetLabel = (owner: {
	readonly kind: "task" | "phase"
	readonly taskId: string
	readonly phaseId?: string
}) =>
	owner.kind === "phase"
		? `phase:${owner.taskId}/${owner.phaseId}`
		: `task:${owner.taskId}`

export const worktree = (options: WorktreeOptions = {}) =>
	Effect.gen(function* () {
		const worktrees = yield* WorktreeService
		const { log } = createLoggers(options)
		const root = options.cwd ?? process.cwd()
		const subcommand = options.subcommand
		const taskId = options.args?.[0]
		const phaseId = options.args?.[1]

		if (subcommand === "list") {
			const inspections = yield* worktrees.list(root)
			if (options.json) return log(JSON.stringify(inspections, null, 2))
			for (const inspection of inspections) {
				for (const checkout of inspection.checkouts) {
					const state = checkout.conflicts.length
						? `conflict:${checkout.conflicts.map(({ kind }) => kind).join(",")}`
						: checkout.exists
							? checkout.dirty
								? "dirty"
								: "ready"
							: "missing"
					log(
						`${targetLabel(inspection.owner)}\t${checkout.kind}\t${checkout.repo}\t${state}\t${checkout.path}`,
					)
				}
			}
			return
		}

		if (!taskId) {
			return yield* Effect.fail(
				new Error("Worktree command requires a task ID"),
			)
		}
		if (subcommand === "inspect") {
			const inspection = yield* worktrees.inspect(taskId, phaseId, root)
			if (options.json) return log(JSON.stringify(inspection, null, 2))
			for (const checkout of inspection.checkouts) {
				const owners = checkout.owners
					.map((owner) => targetLabel(owner))
					.join(",")
				log(
					`${checkout.kind} ${checkout.repo}: path=${checkout.path} registered=${checkout.registeredPath ?? "no"} branch=${checkout.actualBranch ?? "detached"} commit=${checkout.actualCommit ?? "unknown"} owner=${owners || "none"} dirty=${checkout.dirty ?? "unknown"}`,
				)
				for (const conflict of checkout.conflicts) {
					log(`  conflict ${conflict.kind}: ${conflict.message}`)
				}
			}
			return
		}
		if (subcommand === "prepare") {
			const workspace = yield* worktrees.materialize(
				taskId,
				phaseId,
				root,
				options,
			)
			return log(
				options.json
					? JSON.stringify(workspace, null, 2)
					: `${options.dryRun ? "Worktree plan" : "Worktrees ready"}: ${workspace.codePath}`,
			)
		}
		if (subcommand === "remove") {
			const inspection = yield* worktrees.inspect(taskId, phaseId, root)
			const paths = yield* worktrees.remove(taskId, phaseId, root, options)
			const result = {
				operation: "remove",
				dryRun: options.dryRun === true,
				inspection,
				actions: paths.map((path) => `remove ${path}`),
			}
			return log(
				options.json
					? JSON.stringify(result, null, 2)
					: `${options.dryRun ? "Would remove" : "Removed"} ${paths.length} worktree${paths.length === 1 ? "" : "s"}`,
			)
		}
		if (subcommand === "rebuild") {
			const result = yield* worktrees.rebuild(taskId, phaseId, root, options)
			return log(
				options.json
					? JSON.stringify(result, null, 2)
					: `${options.dryRun ? "Would rebuild" : "Rebuilt"} ${result.inspection.codePath}`,
			)
		}
		if (subcommand === "repair") {
			const result = yield* worktrees.repair(taskId, phaseId, root, options)
			return log(
				options.json
					? JSON.stringify(result, null, 2)
					: `${options.dryRun ? "Would repair" : "Repaired"} ${result.inspection.codePath}`,
			)
		}

		return yield* Effect.fail(
			new Error(`Unknown worktree subcommand '${subcommand ?? ""}'`),
		)
	})

export const help = `
Usage: agency worktree <list|inspect|prepare|remove|rebuild|repair>

Inspect and maintain Agency-managed writable and reference worktrees.

Commands:
  list                              List every managed checkout
  inspect <task-id> [phase-id]      Show registration, branch, commit, ownership, and dirtiness
  prepare <task-id> [phase-id]      Create or reuse declared worktrees
  remove <task-id> [phase-id]       Remove clean worktrees while preserving branches
  rebuild <task-id> [phase-id]      Remove and recreate clean, conflict-free worktrees
  repair <task-id> [phase-id]       Repair safe registration issues or missing worktrees

Options:
  --task <id>          Select a task without positional IDs
  --phase <id>         Select a phase with --task
  --dry-run            Preflight and report changes without applying them
  --json               Print structured output
`
