import { lstat, readdir, realpath, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

interface Execution {
	readonly taskId: string
	readonly phaseId?: string
	readonly documentPath: string
	readonly repo: string
	readonly branch: string
	readonly claimActive: boolean
}

interface Workspace {
	readonly path: string
	readonly dirty: boolean
}

interface Blocker {
	readonly kind: string
	readonly target: string
	readonly message: string
}

const run = async (args: readonly string[]) => {
	const process = Bun.spawn([...args], { stdout: "pipe", stderr: "pipe" })
	const [exitCode, stdout] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
	])
	return { exitCode, stdout: stdout.trim() }
}

const directoryExists = async (path: string) => {
	try {
		return (await stat(path)).isDirectory()
	} catch {
		return false
	}
}

const frontmatter = (content: string) => {
	if (!content.startsWith("---\n")) return null
	const end = content.indexOf("\n---\n", 4)
	return end === -1 ? null : content.slice(4, end)
}

const scalar = (content: string, key: string) => {
	const match = content.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"))
	if (!match) return null
	const value = match[1]!
	return value.startsWith('"') && value.endsWith('"')
		? value.slice(1, -1)
		: value
}

const activeClaim = (content: string) => {
	const claim = content.match(/^claim:\s*\n((?:^[ \t]+.*(?:\n|$))*)/m)?.[1]
	return claim ? /^\s+state:\s*active\s*$/m.test(claim) : false
}

const discoverRoot = async (startPath: string) => {
	let current = startPath
	while (true) {
		const configPath = join(current, "agency.json")
		if (await Bun.file(configPath).exists()) return current
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
}

const readExecution = async (
	documentPath: string,
	taskId: string,
	phaseId?: string,
): Promise<Execution | null> => {
	const content = frontmatter(await Bun.file(documentPath).text())
	if (!content || /^repos:/m.test(content) || /^review:/m.test(content))
		return null
	const repo = scalar(content, "repo")
	const branch = scalar(content, "branch")
	if (!repo || !branch) return null
	return {
		taskId,
		...(phaseId ? { phaseId } : {}),
		documentPath,
		repo,
		branch,
		claimActive: activeClaim(content),
	}
}

const readExecutions = async (root: string) => {
	const tasksPath = join(root, "tasks")
	const entries = (await readdir(tasksPath, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.sort((left, right) => left.name.localeCompare(right.name))
	const executions: Execution[] = []
	for (const entry of entries) {
		const taskPath = join(tasksPath, entry.name, "TASK.md")
		const taskContent = frontmatter(await Bun.file(taskPath).text())
		if (!taskContent) return null
		if (/^phases:/m.test(taskContent)) {
			const phasesPath = join(tasksPath, entry.name, "phases")
			const phases = (await readdir(phasesPath, { withFileTypes: true }))
				.filter((phase) => phase.isDirectory())
				.sort((left, right) => left.name.localeCompare(right.name))
			for (const phase of phases) {
				const execution = await readExecution(
					join(phasesPath, phase.name, "PHASE.md"),
					entry.name,
					phase.name,
				)
				if (!execution) return null
				executions.push(execution)
			}
		} else {
			const execution = await readExecution(taskPath, entry.name)
			if (!execution) return null
			executions.push(execution)
		}
	}
	return executions
}

const inspectRepository = async (root: string, alias: string) => {
	const path = join(root, "repos", alias)
	let stats
	try {
		stats = await lstat(path)
	} catch {
		return null
	}
	if (!stats.isDirectory() && !stats.isSymbolicLink()) return null
	const jj = await run(["jj", "-R", path, "root"])
	if (jj.exitCode !== 0) return null
	return {
		alias,
		path,
		kind: stats.isSymbolicLink()
			? ("symlink" as const)
			: ("repository" as const),
		initialized: await directoryExists(join(path, ".jj")),
	}
}

const listWorkspaces = async (repositoryPath: string) => {
	const result = await run([
		"jj",
		"-R",
		repositoryPath,
		"--no-pager",
		"workspace",
		"list",
		"-T",
		'name ++ "\\t" ++ root ++ "\\t" ++ target.empty() ++ "\\n"',
	])
	if (result.exitCode !== 0) return null
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line): Workspace => {
			const [, path, empty] = line.split("\t")
			return { path: path!, dirty: empty === "false" }
		})
}

const inspectVcsStatusFast = async (startPath: string) => {
	const root = await discoverRoot(startPath)
	if (!root) return null
	const config = await Bun.file(join(root, "agency.json")).json()
	if (config?.version !== 2 || config?.vcs !== "jj") return null
	const executions = await readExecutions(root)
	if (!executions) return null

	const localRepositories = (
		await readdir(join(root, "repos"), {
			withFileTypes: true,
		})
	)
		.filter((entry) => !entry.name.startsWith(".agency-"))
		.map((entry) => entry.name)
	const aliases = [
		...new Set([
			...Object.keys(config.repositories ?? {}),
			...localRepositories,
		]),
	].sort()
	const repositories = await Promise.all(
		aliases.map((alias) => inspectRepository(root, alias)),
	)
	if (repositories.some((repository) => repository === null)) return null
	const repositoryRecords = repositories.filter(
		(repository) => repository !== null,
	)
	if (repositoryRecords.some((repository) => !repository.initialized))
		return null

	const workspaceLists = await Promise.all(
		repositoryRecords.map(async (repository) => ({
			alias: repository.alias,
			workspaces: await listWorkspaces(repository.path),
		})),
	)
	if (workspaceLists.some(({ workspaces }) => workspaces === null)) return null
	const workspacesByRepo = new Map(
		workspaceLists.map(({ alias, workspaces }) => [alias, workspaces!]),
	)
	const owners = new Map<string, Execution[]>()
	for (const execution of executions) {
		const key = `${execution.repo}:${execution.branch}`
		const entries = owners.get(key) ?? []
		entries.push(execution)
		owners.set(key, entries)
	}

	const blockers: Blocker[] = []
	for (const execution of executions) {
		if (!execution.claimActive) continue
		const target = execution.phaseId
			? `phase:${execution.taskId}/${execution.phaseId}`
			: `task:${execution.taskId}`
		blockers.push({
			kind: "active-work",
			target,
			message: `${target} is active; finish or release it before migration`,
		})
	}

	let workspaceCount = 0
	for (const execution of executions) {
		const checkoutPath = join(
			dirname(execution.documentPath),
			"code",
			execution.repo,
		)
		const exists = await directoryExists(checkoutPath)
		const expectedPath = exists
			? await realpath(checkoutPath)
			: resolve(checkoutPath)
		const registered = workspacesByRepo
			.get(execution.repo)
			?.find((workspace) => workspace.path === expectedPath)
		const conflicts: string[] = []
		if ((owners.get(`${execution.repo}:${execution.branch}`)?.length ?? 0) > 1)
			conflicts.push(
				`Branch '${execution.branch}' for repository '${execution.repo}' has multiple Agency owners`,
			)
		if (registered && !exists)
			conflicts.push(
				`Workspace registry contains a missing checkout at ${checkoutPath}`,
			)
		if (exists && !registered)
			conflicts.push(
				`Existing checkout ${checkoutPath} is not registered as a jj workspace`,
			)
		if (conflicts.length > 0) {
			blockers.push({
				kind: "workspace-conflict",
				target: checkoutPath,
				message: conflicts.join("; "),
			})
			continue
		}
		if (!exists || !registered) continue
		if (registered.dirty) {
			blockers.push({
				kind: "dirty-workspace",
				target: checkoutPath,
				message: `Workspace ${checkoutPath} must be clean before migration`,
			})
			continue
		}
		workspaceCount++
	}

	return {
		root,
		configured: "jj",
		source: "jj",
		target: "jj",
		available: { git: Bun.which("git") !== null, jj: Bun.which("jj") !== null },
		repositories: repositoryRecords,
		workspaceCount,
		blockers,
	}
}

export const runVcsStatusFast = async (
	json: boolean,
	startPath: string = process.cwd(),
	write: (message: string) => void = console.log,
) => {
	const status = await inspectVcsStatusFast(startPath)
	if (!status) return false
	if (json) {
		write(JSON.stringify({ version: 1, ok: true, result: status }))
	} else {
		write("Version control: jj")
		write(
			`Tools: git=${status.available.git ? "available" : "missing"} jj=${status.available.jj ? "available" : "missing"}`,
		)
		write(
			`Repositories: ${status.repositories.length}; managed workspaces: ${status.workspaceCount}; blockers: ${status.blockers.length}`,
		)
		for (const blocker of status.blockers)
			write(`blocker ${blocker.kind} ${blocker.target}: ${blocker.message}`)
	}
	return true
}
