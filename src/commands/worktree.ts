import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { createLoggers } from "../utils/effect"
import { WorktreeService } from "../services/WorktreeService"
import { resolveTaskSelector } from "../workbase/item-selector"

interface WorktreeOptions extends BaseCommandOptions {
	readonly subcommand?: string
	readonly args?: readonly string[]
	readonly force?: boolean
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
		const cwd = options.cwd ?? process.cwd()
		const subcommand = options.subcommand

		if (subcommand === "list") {
			const inspections = yield* worktrees.list(cwd)
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

		if (
			!["inspect", "prepare", "remove", "rebuild", "repair"].includes(
				subcommand ?? "",
			)
		) {
			return yield* Effect.fail(
				new Error(`Unknown worktree subcommand '${subcommand ?? ""}'`),
			)
		}
		const target = yield* resolveTaskSelector(options.args?.[0], cwd)
		const root = target.root
		const taskId = target.taskId
		const phaseId = options.args?.[1] ?? target.phaseId
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

Inspect and maintain Agency-managed writable and reference workspaces.

Commands:
  list                              List every managed checkout
  inspect [task [phase-id]]         Show registration, branch, commit, ownership, and dirtiness
  prepare [task [phase-id]]         Create or reuse declared worktrees
  remove [task [phase-id]]          Remove clean worktrees while preserving branches
  rebuild [task [phase-id]]         Remove and recreate clean, conflict-free worktrees
  repair [task [phase-id]]          Repair safe registration issues or missing worktrees

The task is an ID or a path to a task or phase document or directory; a phase
path also selects that phase. When omitted, the task or phase containing the
current directory is used.

Options:
  --task <id>          Select a task without positional IDs
  --phase <id>         Select a phase with --task
  --dry-run            Preflight and report changes without applying them
  --force              Override an existing worktree operation lock
  --json               Print structured output
`
