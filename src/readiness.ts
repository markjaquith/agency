import type { WorkStatus } from "./workbase/schemas"

export interface ReadinessBlocker {
	readonly id: string
}

export const WORK_STATUS_TRANSITIONS = {
	open: ["open", "working", "delegated", "dropped"],
	working: ["open", "working", "delegated", "dropped"],
	delegated: ["open", "working", "delegated", "dropped"],
	done: ["open", "done"],
	dropped: ["open", "dropped"],
} as const satisfies Record<WorkStatus, readonly WorkStatus[]>

export const isTerminalStatus = (status: WorkStatus) =>
	status === "done" || status === "dropped"

export const isDependencySatisfied = (status: WorkStatus | undefined) =>
	status === "done"

export const canTransitionStatus = (from: WorkStatus, to: WorkStatus) =>
	(WORK_STATUS_TRANSITIONS[from] as readonly WorkStatus[]).includes(to)

export const aggregateProgress = (statuses: readonly WorkStatus[]) => {
	const counts = {
		total: statuses.length,
		open: 0,
		working: 0,
		delegated: 0,
		done: 0,
		dropped: 0,
		terminal: 0,
	}
	for (const status of statuses) {
		counts[status] += 1
		if (isTerminalStatus(status)) counts.terminal += 1
	}
	const status: WorkStatus =
		counts.total === 0
			? "open"
			: counts.done === counts.total
				? "done"
				: counts.terminal === counts.total
					? "dropped"
					: counts.working > 0
						? "working"
						: counts.delegated > 0
							? "delegated"
							: "open"
	return { status, ...counts }
}

export const readinessState = (
	status: WorkStatus,
	blockers: readonly ReadinessBlocker[],
	ready = status === "open" && blockers.length === 0,
) => ({
	ready,
	blocked: !ready && blockers.length > 0,
	blockedBy: [...new Set(blockers.map((blocker) => blocker.id))].sort(),
	terminal: isTerminalStatus(status),
})
