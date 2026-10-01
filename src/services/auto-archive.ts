import { Effect } from "effect"
import type {
	GitVersionControlService,
	VersionControlService,
} from "./VersionControlService"
import type { ArchiveService } from "./ArchiveService"
import { WorkbaseService } from "./WorkbaseService"
import type { FileSystemService } from "./FileSystemService"
import { TaskService } from "./TaskService"
import { PhaseService } from "./PhaseService"
import type { EpicService } from "./EpicService"
import type { WorktreeService } from "./WorktreeService"
import { aggregateProgress, isTerminalStatus } from "../readiness"

export interface AutoArchiveResult {
	readonly taskId: string
	readonly status: "disabled" | "non-terminal" | "archived" | "skipped"
	readonly path?: string
	readonly reason?: string
}

// A terminal transition is durable even when archive safety checks reject cleanup.
// Explicit typing also keeps the lazy service references free of inference cycles.
export const autoArchiveTask = (
	taskId: string,
	startPath: string,
): Effect.Effect<
	AutoArchiveResult,
	never,
	| WorkbaseService
	| ArchiveService
	| FileSystemService
	| TaskService
	| PhaseService
	| EpicService
	| WorktreeService
	| GitVersionControlService
	| VersionControlService
> =>
	Effect.gen(function* () {
		const workbase = yield* WorkbaseService
		const { root, config } = yield* workbase.loadConfig(startPath)
		if (!config.autoArchive) return { taskId, status: "disabled" as const }
		const tasks = yield* TaskService
		const task = yield* tasks.show(taskId, root)
		let status
		if ("phases" in task.data) {
			const phases = yield* PhaseService
			const records = yield* Effect.forEach(task.data.phases, (phase) =>
				phases.show(taskId, phase.id, root),
			)
			status = aggregateProgress(
				records.map((phase) => phase.data.status),
			).status
		} else status = task.data.status
		if (!isTerminalStatus(status))
			return { taskId, status: "non-terminal" as const }
		// ArchiveService uses TaskService for preflight; resolve it only after the
		// terminal write to avoid an eager module initialization cycle.
		const { ArchiveService } = yield* Effect.promise(
			() => import("./ArchiveService"),
		)
		const archives = yield* ArchiveService
		// archiveTask always performs the same preflight as --dry-run before applying.
		const result = yield* archives.archiveTask(taskId, root)
		return { taskId, status: "archived" as const, path: result.path }
	}).pipe(
		Effect.catch((error) =>
			Effect.succeed({
				taskId,
				status: "skipped" as const,
				reason: error.message,
			}),
		),
	)

export const autoArchiveMessage = (result: AutoArchiveResult | undefined) =>
	result?.status === "archived"
		? `Auto-archived task '${result.taskId}' to ${result.path}`
		: result?.status === "skipped"
			? `Auto-archive skipped for task '${result.taskId}': ${result.reason}`
			: undefined
