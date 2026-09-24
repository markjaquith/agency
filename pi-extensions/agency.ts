import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"

type ExtensionAPI = {
	exec: (
		command: string,
		args: string[],
		options: { timeout: number },
	) => Promise<{ code: number; stdout: string }>
	on(name: "session_start", handler: () => void): void
	on(
		name: "resources_discover",
		handler: (event: {
			cwd: string
		}) => Promise<{ skillPaths: string[] } | undefined>,
	): void
	on(
		name: "before_agent_start",
		handler: (
			event: { systemPrompt: string },
			ctx: { cwd: string },
		) => Promise<{ systemPrompt: string } | undefined>,
	): void
}

type AgencyContext = {
	root?: string
	checkout?: string
	documentDirectory?: string
	target?: string
	working?: boolean
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
			!result.authority?.writable?.checkoutPath)
	)
		return

	return {
		root,
		checkout: result.authority?.writable?.checkoutPath,
		documentDirectory: result.target?.path
			? dirname(result.target.path)
			: undefined,
		target,
		working: status === "working",
	}
}

export default function agencyExtension(pi: ExtensionAPI) {
	const contexts = new Map<
		string,
		{
			promise: Promise<AgencyContext | undefined>
			expiresAt: number
			retryDelay: number
		}
	>()
	// Pi emits session_start for startup, reload, new, resume, and fork.
	// Resource discovery follows it and must share the same cached lookup.
	pi.on("session_start", () => contexts.clear())

	const runtimeContext = (directory: string) => {
		const key = resolve(directory)
		const previous = contexts.get(key)
		if (previous && Date.now() < previous.expiresAt) return previous.promise

		const entry = {
			promise: agencyContext(pi, key)
				.catch(() => undefined)
				.then((context) => {
					entry.retryDelay = context
						? 0
						: Math.min((previous?.retryDelay || 500) * 2, 30_000)
					entry.expiresAt = Date.now() + (context ? 60_000 : entry.retryDelay)
					return context
				}),
			expiresAt: Infinity,
			retryDelay: 0,
		}
		contexts.set(key, entry)
		return entry.promise
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
				activeTarget && context.target === activeTarget && context.working
					? `Agency verified this Pi session as the active worker for ${activeTarget}. Perform the assigned work directly. Do not invoke agency work for this target or launch a replacement worker.`
					: undefined
			const access = `The complete Agency workbase is available at ${context.root}. Use absolute paths under that root when workbase context is needed. Agency context remains the authority for writes.`
			const checkout = context.checkout ? resolve(context.checkout) : undefined
			const current = resolve(ctx.cwd)
			const repository =
				checkout &&
				(current === checkout || current.startsWith(`${checkout}${sep}`))
			const implementation = checkout
				? [
						repository
							? `Pi is rooted in Agency's authoritative writable checkout at ${checkout}. Use this directory for source reads, edits, Git status and other Git operations, builds, tests, and formatting.`
							: `Agency's authoritative writable checkout is ${checkout}. Before doing implementation work or Git operations, change the working directory to that checkout. Set each tool's working directory to it when supported; otherwise use absolute paths.`,
						context.documentDirectory
							? `Run Agency lifecycle commands from ${context.documentDirectory}; agency context may also be queried from the checkout.`
							: undefined,
						"Any reference checkouts reported by Agency context are read-only.",
					]
						.filter(Boolean)
						.join(" ")
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
