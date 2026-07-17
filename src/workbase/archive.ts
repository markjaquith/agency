import { join } from "node:path"

const lifecycleManifestName = ".agency-lifecycle.json"

export const archivedEpicDirectory = (root: string, id: string) =>
	join(root, "archive", "epics", id)

export const archivedTaskDirectory = (root: string, id: string) =>
	join(root, "archive", "tasks", id)

export const archivedPhaseDirectory = (
	root: string,
	taskId: string,
	id: string,
) => join(archivedTaskDirectory(root, taskId), "phases", id)

export const lifecycleManifestPath = (directory: string) =>
	join(directory, lifecycleManifestName)
