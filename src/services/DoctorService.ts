import { Effect, Either } from "effect"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { IntegrationService } from "./IntegrationService"
import type { PhaseRecord } from "./PhaseService"
import { RepositoryService } from "./RepositoryService"
import type { TaskRecord } from "./TaskService"
import { WorkbaseService } from "./WorkbaseService"
import { WorktreeService } from "./WorktreeService"
import { VersionControlService } from "./VersionControlService"

type DoctorCheckLevel = "error" | "warning" | "optional"

interface DoctorCheck {
	readonly id: string
	readonly category:
		| "tool"
		| "integration"
		| "workbase"
		| "repository"
		| "ref"
		| "worktree"
		| "permission"
	readonly level: DoctorCheckLevel
	readonly status: "pass" | "fail"
	readonly message: string
	readonly remediation: string | null
}

interface DoctorReport {
	readonly version: 1
	readonly root: string
	readonly healthy: boolean
	readonly summary: {
		readonly passed: number
		readonly errors: number
		readonly warnings: number
		readonly optional: number
	}
	readonly checks: readonly DoctorCheck[]
}

const executableAvailable = (executable: string, root: string) =>
	Effect.tryPromise({
		try: async () => {
			if (executable.includes("/")) {
				const path = isAbsolute(executable)
					? executable
					: resolve(root, executable)
				await access(path, constants.X_OK)
				return true
			}
			return Bun.which(executable) !== null
		},
		catch: () => false,
	}).pipe(Effect.catchAll(() => Effect.succeed(false)))

const permissionAvailable = (path: string, mode: number) =>
	Effect.tryPromise({
		try: () => access(path, mode).then(() => true),
		catch: () => false,
	}).pipe(Effect.catchAll(() => Effect.succeed(false)))

const messageOf = (error: unknown) =>
	error instanceof Error
		? error.message
		: typeof error === "object" &&
			  error !== null &&
			  "message" in error &&
			  typeof error.message === "string"
			? error.message
			: String(error)

export class DoctorService extends Effect.Service<DoctorService>()(
	"DoctorService",
	{
		sync: () => ({
			inspect: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const integrations = yield* IntegrationService
					const repositories = yield* RepositoryService
					const workbases = yield* WorkbaseService
					const worktrees = yield* WorktreeService
					const versionControl = yield* VersionControlService
					const { root, config } = yield* workbases.loadConfig(startPath)
					const backend = yield* versionControl.forWorkbase(root)
					const checks: DoctorCheck[] = []
					const add = (
						check: Omit<DoctorCheck, "remediation"> & {
							readonly remediation?: string
						},
					) =>
						checks.push({
							...check,
							remediation:
								check.status === "fail"
									? (check.remediation ?? "Remediation is unknown.")
									: null,
						})

					const tool = (
						id: string,
						executable: string,
						level: DoctorCheckLevel,
						label: string,
					) =>
						Effect.gen(function* () {
							const available = yield* executableAvailable(executable, root)
							add({
								id,
								category: id.startsWith("tool.") ? "tool" : "integration",
								level,
								status: available ? "pass" : "fail",
								message: available
									? `${label} executable '${executable}' is available`
									: `${label} executable '${executable}' is unavailable`,
								remediation:
									level === "optional"
										? `Install '${executable}' to enable ${label.toLowerCase()}, or leave it unavailable if unused.`
										: `Install '${executable}' and ensure it is executable on PATH.`,
							})
							return available
						})

					const [gitAvailable, jjAvailable] = yield* Effect.all(
						[
							tool("tool.git", "git", "error", "Git"),
							tool(
								"tool.jj",
								"jj",
								config.vcs === "jj" ? "error" : "optional",
								"Jujutsu",
							),
						],
						{ concurrency: "unbounded", batching: true },
					)
					const versionControlAvailable =
						gitAvailable && (config.vcs !== "jj" || jjAvailable)
					yield* Effect.all(
						[
							tool(
								"capability.agent.opencode",
								"opencode",
								"optional",
								"OpenCode agent",
							),
							tool(
								"capability.agent.claude",
								"claude",
								"optional",
								"Claude agent",
							),
						],
						{ concurrency: "unbounded", batching: true },
					)

					const configuredCommands: readonly (readonly [
						string,
						readonly string[],
						string,
					])[] = [
						...(config.chooserCommand
							? [
									[
										"integration.chooser",
										config.chooserCommand,
										"Chooser",
									] as const,
								]
							: []),
						...(config.worktreeCreateCommand
							? [
									[
										"integration.worktree-create",
										config.worktreeCreateCommand,
										"Worktree creator",
									] as const,
								]
							: []),
						...(config.workspaceCreateCommand
							? [
									[
										"integration.workspace-create",
										config.workspaceCreateCommand,
										"Workspace creator",
									] as const,
								]
							: []),
						...Object.entries(config.repositories ?? {}).flatMap(
							([alias, repository]) =>
								repository.postCheckoutCommand
									? [
											[
												`integration.repository.${alias}.post-checkout`,
												repository.postCheckoutCommand,
												`Repository '${alias}' post-checkout hook`,
											] as const,
										]
									: [],
						),
						...Object.entries(config.agents ?? {}).map(
							([name, agent]) =>
								[
									`integration.agent.${name}`,
									agent.command,
									`Configured agent '${name}'`,
								] as const,
						),
						...Object.entries(config.agents ?? {}).flatMap(([name, agent]) =>
							agent.autoCommand
								? [
										[
											`integration.agent.${name}.auto`,
											agent.autoCommand,
											`Configured agent '${name}' auto`,
										] as const,
									]
								: [],
						),
						...Object.entries(config.agents ?? {}).flatMap(([name, agent]) =>
							agent.resumeCommand
								? [
										[
											`integration.agent.${name}.resume`,
											agent.resumeCommand,
											`Configured agent '${name}' resume`,
										] as const,
									]
								: [],
						),
						...Object.entries(config.agents ?? {}).flatMap(([name, agent]) =>
							agent.autoResumeCommand
								? [
										[
											`integration.agent.${name}.auto-resume`,
											agent.autoResumeCommand,
											`Configured agent '${name}' auto resume`,
										] as const,
									]
								: [],
						),
						...(config.delivery
							? [
									[
										`integration.delivery.${config.delivery.provider}`,
										config.delivery.createCommand,
										`Delivery provider '${config.delivery.provider}'`,
									] as const,
									[
										`integration.delivery.${config.delivery.provider}.query`,
										config.delivery.queryCommand,
										`Delivery provider '${config.delivery.provider}' query`,
									] as const,
								]
							: []),
					]
					yield* Effect.all(
						configuredCommands.map(([id, command, label]) =>
							tool(id, command[0]!, "error", label),
						),
						{ concurrency: 16, batching: true },
					)

					const validation = yield* workbases.validate(root, {
						includeDocuments: true,
					})
					add({
						id: "workbase.validation",
						category: "workbase",
						level: "error",
						status: validation.valid ? "pass" : "fail",
						message: validation.valid
							? "Workbase documents and relationships are valid"
							: `Workbase validation found ${validation.issues.length} issue(s): ${validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
						remediation:
							"Run 'agency validate' and correct every reported issue.",
					})

					const permissionChecks = [
						[
							"permission.workbase.read",
							constants.R_OK,
							"error",
							"readable",
							`Grant the current user read access to ${root}.`,
						],
						[
							"permission.workbase.write",
							constants.W_OK,
							"warning",
							"writable",
							`Grant the current user write access to ${root} before running mutation commands.`,
						],
					] as const
					const permissionResults = yield* Effect.all(
						permissionChecks.map(([, mode]) => permissionAvailable(root, mode)),
						{ concurrency: "unbounded", batching: true },
					)
					for (const [
						index,
						[id, , level, label, remediation],
					] of permissionChecks.entries()) {
						const available = permissionResults[index]!
						add({
							id,
							category: "permission",
							level,
							status: available ? "pass" : "fail",
							message: `Workbase root is ${available ? "" : "not "}${label}`,
							remediation,
						})
					}

					const integrationStatus = yield* integrations.status(root)
					for (const file of integrationStatus.files) {
						const failed =
							file.state === "missing" ||
							file.state === "drifted" ||
							(file.name === "opencode" && file.state === "customized")
						add({
							id: `integration.file.${file.name}`,
							category: "integration",
							level:
								file.name === "agents" && file.state === "customized"
									? "optional"
									: "warning",
							status: failed ? "fail" : "pass",
							message: `${file.name} integration file is ${file.state}: ${file.path}. ${file.diagnostic}`,
							remediation: file.remediation ?? undefined,
						})
					}

					const refs = new Map<string, Set<string>>()
					const reviewSources: { repo: string; task: string; ref: string }[] =
						[]
					const declareRef = (repo: string, ref: string) => {
						const values = refs.get(repo) ?? new Set<string>()
						values.add(ref)
						refs.set(repo, values)
					}
					if (validation.valid && validation.documents) {
						for (const epic of validation.documents.epics) {
							for (const reference of epic.data.repos)
								declareRef(reference.repo, reference.ref)
						}
						for (const task of validation.documents.tasks) {
							if ("review" in task.data) {
								declareRef(task.data.review.repo, task.data.review.commit)
								reviewSources.push({
									repo: task.data.review.repo,
									task: task.id,
									ref:
										task.data.review.source.kind === "pull-request"
											? task.data.review.source.fetchRef
											: task.data.review.source.ref
													.replace(/^refs\/remotes\/origin\//, "")
													.replace(/^origin\//, ""),
								})
							} else if ("repo" in task.data) {
								declareRef(task.data.repo, task.data.base)
								for (const reference of task.data.repos ?? [])
									declareRef(reference.repo, reference.ref)
							} else {
								for (const phase of validation.documents.phasesByTask.get(
									task.id,
								) ?? []) {
									declareRef(phase.data.repo, phase.data.base)
									for (const reference of phase.data.repos ?? [])
										declareRef(reference.repo, reference.ref)
								}
							}
						}
					}

					const repositoryList = versionControlAvailable
						? yield* repositories.list(root)
						: []
					if (!versionControlAvailable) {
						add({
							id: "repository.inspection",
							category: "repository",
							level: "warning",
							status: "fail",
							message: `Repository, ref, remote, and workspace checks were skipped because the ${config.vcs ?? "git"} backend is unavailable`,
							remediation: `Install '${config.vcs === "jj" ? "jj" : "git"}' and rerun 'agency doctor'.`,
						})
					}
					for (const repository of repositoryList) {
						const missing = repository.states.includes("missing")
						const repositoryValid =
							!missing && !repository.states.includes("invalid")
						add({
							id: `repository.${repository.alias}.valid`,
							category: "repository",
							level: "error",
							status: repositoryValid ? "pass" : "fail",
							message: missing
								? `Repository '${repository.alias}' is declared but not materialized`
								: repositoryValid
									? `Repository '${repository.alias}' is a valid Git repository`
									: `Repository '${repository.alias}' is not a valid Git repository`,
							remediation: missing
								? "Run 'agency repo setup --apply'."
								: `Run 'agency repo verify ${repository.alias}', then repair or relink the repository.`,
						})
						add({
							id: `repository.${repository.alias}.remote`,
							category: "repository",
							level: "warning",
							status:
								repository.declaredRemote &&
								!repository.states.includes("remote-drifted")
									? "pass"
									: "fail",
							message: repository.states.includes("remote-drifted")
								? `Repository '${repository.alias}' origin differs from ${repository.declaredRemote}`
								: repository.declaredRemote
									? `Repository '${repository.alias}' portable origin is ${repository.declaredRemote}`
									: `Repository '${repository.alias}' has no portable origin declaration`,
							remediation: `Run 'agency repo remote ${repository.alias} <url>' to configure origin.`,
						})
						if (!repositoryValid) continue

						for (const source of reviewSources.filter(
							(item) => item.repo === repository.alias,
						)) {
							const observed = repository.remote
								? yield* fs.runCommand(
										["git", "ls-remote", repository.remote, source.ref],
										{ captureOutput: true },
									)
								: { exitCode: -1, stdout: "", stderr: "origin unavailable" }
							const available =
								observed.exitCode === 0 && Boolean(observed.stdout.trim())
							add({
								id: `review.${source.task}.source`,
								category: "repository",
								level: "warning",
								status: available ? "pass" : "fail",
								message: available
									? `Review source '${source.ref}' is available for task '${source.task}'`
									: `Review source '${source.ref}' is unavailable for task '${source.task}'; its pin remains usable`,
								remediation: available
									? undefined
									: "Use the pinned checkout or refresh after restoring the source.",
							})
						}

						for (const ref of [...(refs.get(repository.alias) ?? [])].sort()) {
							const found =
								(yield* backend.resolveRevision(repository.path, ref)) !== null
							add({
								id: `ref.${repository.alias}.${ref}`,
								category: "ref",
								level: "error",
								status: found ? "pass" : "fail",
								message: `Declared ref '${ref}' for '${repository.alias}' is ${found ? "available" : "missing"}`,
								remediation: `Run 'agency repo fetch ${repository.alias}' and verify that ref '${ref}' exists on origin.`,
							})
						}
					}

					if (validation.valid && versionControlAvailable) {
						const tasks = validation.documents?.tasks.map(
							(record) =>
								({ ...record, content: "", revision: "" }) satisfies TaskRecord,
						)
						const phasesByTask = validation.documents
							? new Map(
									[...validation.documents.phasesByTask].map(
										([taskId, records]) =>
											[
												taskId,
												records.map(
													(record) =>
														({
															...record,
															taskId,
															content: "",
															revision: "",
														}) satisfies PhaseRecord,
												),
											] as const,
									),
								)
							: undefined
						const inspected = yield* Effect.either(
							worktrees.list(root, {
								materializedOnly: true,
								tasks,
								phasesByTask,
							}),
						)
						if (Either.isLeft(inspected)) {
							add({
								id: "worktree.inspection",
								category: "worktree",
								level: "warning",
								status: "fail",
								message: `Worktree inspection failed: ${messageOf(inspected.left)}`,
								remediation:
									"Remediation is unknown; inspect repositories with 'agency worktree list --json'.",
							})
						} else {
							for (const inspection of inspected.right) {
								const target =
									inspection.owner.kind === "phase"
										? `${inspection.owner.taskId}.${inspection.owner.phaseId}`
										: inspection.owner.taskId
								add({
									id: `worktree.${inspection.owner.kind}.${target}`,
									category: "worktree",
									level: "error",
									status: inspection.conflicts.length === 0 ? "pass" : "fail",
									message:
										inspection.conflicts.length === 0
											? `Worktree registrations for '${target}' are consistent`
											: inspection.conflicts
													.map((conflict) => conflict.message)
													.join("; "),
									remediation: `Run 'agency worktree inspect ${inspection.owner.taskId}${inspection.owner.phaseId ? ` ${inspection.owner.phaseId}` : ""}', then use 'agency worktree repair' if appropriate.`,
								})
							}
						}
					}

					const summary = {
						passed: checks.filter((check) => check.status === "pass").length,
						errors: checks.filter(
							(check) => check.status === "fail" && check.level === "error",
						).length,
						warnings: checks.filter(
							(check) => check.status === "fail" && check.level === "warning",
						).length,
						optional: checks.filter(
							(check) => check.status === "fail" && check.level === "optional",
						).length,
					}
					return {
						version: 1,
						root,
						healthy: summary.errors === 0,
						summary,
						checks,
					} satisfies DoctorReport
				}),
		}),
	},
) {}
