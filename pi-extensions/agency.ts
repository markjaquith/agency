import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

type ExtensionAPI = {
	exec: (
		command: string,
		args: string[],
		options: { timeout: number },
	) => Promise<{ code: number; stdout: string }>
	on: (
		name: "resources_discover" | "before_agent_start",
		handler: (...args: any[]) => unknown,
	) => void
}

type AgencyContext = {
	root?: string
	checkout?: string
	target?: string
}

const contextTarget = (result: Record<string, any>): string | undefined => {
	const target = result.target
	if (target?.kind === "epic") return `epic:${target.epicId}`
	if (target?.kind === "phase") {
		return `execution-unit:phase/${target.taskId}/${target.phaseId}`
	}
	if (target?.kind === "task") {
		return result.authority?.mode === "execution"
			? `execution-unit:task/${target.taskId}`
			: `task:${target.taskId}`
	}
}

const discoverWorkbase = (directory: string) => {
	let current = resolve(directory)
	while (true) {
		if (existsSync(join(current, "agency.json"))) return current
		const parent = dirname(current)
		if (parent === current) return
		current = parent
	}
}

const agencyContext = async (
	pi: ExtensionAPI,
	directory: string,
): Promise<AgencyContext | undefined> => {
	const root = discoverWorkbase(directory)
	if (!root) return

	const command = await pi.exec(
		"agency",
		["context", directory, "--compact", "--json"],
		{ timeout: 5000 },
	)
	if (command.code !== 0) return

	const envelope = JSON.parse(command.stdout)
	if (envelope.ok !== true) return
	const result = envelope.result ?? {}
	const target = contextTarget(result)
	const status =
		result.documents?.phase?.data?.status ??
		result.documents?.task?.data?.status
	if (
		result.validation?.valid !== true ||
		result.workbase?.root !== root ||
		!target ||
		(target.startsWith("execution-unit:") &&
			(!result.authority?.writable?.checkoutPath || status !== "working"))
	)
		return

	return {
		root,
		checkout: result.authority?.writable?.checkoutPath,
		target,
	}
}

export default function agencyExtension(pi: ExtensionAPI) {
	const contexts = new Map<string, Promise<AgencyContext | undefined>>()
	const runtimeContext = (directory: string) => {
		const key = resolve(directory)
		let context = contexts.get(key)
		if (!context) {
			context = agencyContext(pi, key).catch(() => undefined)
			contexts.set(key, context)
		}
		return context
	}

	pi.on("resources_discover", async (event: { cwd: string }) => {
		const context = await runtimeContext(event.cwd)
		if (!context?.checkout) return

		const skillPaths = [
			join(context.checkout, ".claude", "skills"),
			join(context.checkout, ".agents", "skills"),
			join(context.checkout, ".opencode", "skill"),
			join(context.checkout, ".opencode", "skills"),
			join(context.checkout, ".pi", "skills"),
		].filter(existsSync)
		if (skillPaths.length > 0) return { skillPaths: [...new Set(skillPaths)] }
	})

	pi.on(
		"before_agent_start",
		async (event: { systemPrompt: string }, ctx: { cwd: string }) => {
			const context = await runtimeContext(ctx.cwd)
			if (!context?.root) return

			const instructionsPath = join(context.root, ".agency", "AGENTS.md")
			const instructions = existsSync(instructionsPath)
				? readFileSync(instructionsPath, "utf8").trim()
				: undefined
			const activeTarget = process.env.AGENCY_TARGET
			const worker =
				activeTarget && context.target === activeTarget
					? `Agency verified this Pi session as the active worker for ${activeTarget}. Perform the assigned work directly. Do not invoke agency work for this target or launch a replacement worker.`
					: undefined
			const access = `The complete Agency workbase is available at ${context.root}. Use absolute paths under that root when workbase context is needed. Agency context remains the authority for writes.`
			const implementation = context.checkout
				? `Pi remains rooted in the task or phase directory for Agency instructions and context. Treat ${context.checkout} as the default implementation directory for source reads, edits, repository status, builds, tests, formatting, and other repository-local commands. Run Agency lifecycle and context commands from the task or phase directory. Any reference checkouts reported by Agency context are read-only.`
				: undefined

			return {
				systemPrompt: [
					event.systemPrompt,
					instructions,
					access,
					worker,
					implementation,
				]
					.filter(Boolean)
					.join("\n\n"),
			}
		},
	)
}
