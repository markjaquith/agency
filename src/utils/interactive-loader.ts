export const loadInteractive = async () => {
	// Resolve this at runtime so the Node-target bundle still selects Bun's preload.
	const preload = ["@opentui", "solid", "preload"].join("/")
	await import(preload)
	return import("./interactive")
}
