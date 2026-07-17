import type { Dependency } from "./schemas"

export const findDependencyCycles = (
	nodes: readonly Dependency[],
): readonly string[] => {
	const dependencies = new Map(
		nodes.map((node) => [node.id, [...(node.dependsOn ?? [])]]),
	)
	const visiting = new Set<string>()
	const visited = new Set<string>()
	const cycles = new Set<string>()

	const visit = (id: string) => {
		if (visiting.has(id)) {
			cycles.add(id)
			return
		}
		if (visited.has(id)) return

		visiting.add(id)
		for (const dependency of dependencies.get(id) ?? []) {
			if (dependencies.has(dependency)) visit(dependency)
		}
		visiting.delete(id)
		visited.add(id)
	}

	for (const id of dependencies.keys()) visit(id)
	return [...cycles].sort()
}

export const validateDependencies = (
	nodes: readonly Dependency[],
	label: string,
): string | undefined => {
	const singular = label.endsWith("s") ? label.slice(0, -1) : label
	const ids = new Set(nodes.map((node) => node.id))
	if (ids.size !== nodes.length) return `${label} IDs must be unique`
	for (const node of nodes) {
		for (const dependency of node.dependsOn ?? []) {
			if (dependency === node.id) {
				return `${singular} '${node.id}' cannot depend on itself`
			}
			if (!ids.has(dependency)) {
				return `Unknown ${singular.toLowerCase()} dependency '${dependency}'`
			}
		}
	}
	const cycle = findDependencyCycles(nodes)[0]
	return cycle ? `${singular} dependency cycle includes '${cycle}'` : undefined
}
