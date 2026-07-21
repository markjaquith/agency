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
		open: statuses.filter((status) => status === "open").length,
		working: statuses.filter((status) => status === "working").length,
		delegated: statuses.filter((status) => status === "delegated").length,
		done: statuses.filter((status) => status === "done").length,
		dropped: statuses.filter((status) => status === "dropped").length,
		terminal: statuses.filter(isTerminalStatus).length,
	}
	const status: WorkStatus =
		statuses.length === 0
			? "open"
			: statuses.every((value) => value === "done")
				? "done"
				: statuses.every(isTerminalStatus)
					? "dropped"
					: statuses.includes("working")
						? "working"
						: statuses.includes("delegated")
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
