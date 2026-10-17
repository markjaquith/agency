const preload = async () => {
	// Resolve this at runtime so the Node-target bundle still selects Bun's preload.
	const path = ["@opentui", "solid", "preload"].join("/")
	await import(path)
}

export const loadInteractive = async () => {
	await preload()
	return import("./interactive")
}

export const loadSupervisorTab = async () => {
	await preload()
	return import("./supervise-tab")
}
