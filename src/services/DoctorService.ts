import { Effect, Either } from "effect"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { EpicService } from "./EpicService"
import { FileSystemService } from "./FileSystemService"
import { IntegrationService } from "./IntegrationService"
import { PhaseService } from "./PhaseService"
import { RepositoryService } from "./RepositoryService"
import { TaskService } from "./TaskService"
import { WorkbaseService } from "./WorkbaseService"
import { WorktreeService } from "./WorktreeService"

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
					const epics = yield* EpicService
					const fs = yield* FileSystemService
					const integrations = yield* IntegrationService
					const phases = yield* PhaseService
					const repositories = yield* RepositoryService
					const tasks = yield* TaskService
					const workbases = yield* WorkbaseService
					const worktrees = yield* WorktreeService
					const { root, config } = yield* workbases.loadConfig(startPath)
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

					const tool = function* (
						id: string,
						executable: string,
						level: DoctorCheckLevel,
						label: string,
					) {
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
					}

					const gitAvailable = yield* tool("tool.git", "git", "error", "Git")
					yield* tool(
						"capability.runner.opencode",
						"opencode",
						"optional",
						"OpenCode runner",
					)
					yield* tool(
						"capability.runner.claude",
						"claude",
						"optional",
						"Claude runner",
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
						...Object.entries(config.runners ?? {}).map(
							([name, runner]) =>
								[
									`integration.runner.${name}`,
									runner.command,
									`Configured runner '${name}'`,
								] as const,
						),
						...Object.entries(config.runners ?? {}).flatMap(([name, runner]) =>
							runner.autoCommand
								? [
										[
											`integration.runner.${name}.auto`,
											runner.autoCommand,
											`Configured runner '${name}' auto`,
										] as const,
									]
								: [],
						),
						...Object.entries(config.runners ?? {}).flatMap(([name, runner]) =>
							runner.resumeCommand
								? [
										[
											`integration.runner.${name}.resume`,
											runner.resumeCommand,
											`Configured runner '${name}' resume`,
										] as const,
									]
								: [],
						),
						...Object.entries(config.runners ?? {}).flatMap(([name, runner]) =>
							runner.autoResumeCommand
								? [
										[
											`integration.runner.${name}.auto-resume`,
											runner.autoResumeCommand,
											`Configured runner '${name}' auto resume`,
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
					for (const [id, command, label] of configuredCommands) {
						yield* tool(id, command[0]!, "error", label)
					}

					const validation = yield* workbases.validate(root)
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

					for (const [id, mode, level, label, remediation] of [
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
					] as const) {
						const available = yield* permissionAvailable(root, mode)
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
					if (validation.valid) {
						for (const epic of yield* epics.list(root)) {
							for (const reference of epic.data.repos)
								declareRef(reference.repo, reference.ref)
						}
						for (const task of yield* tasks.list(root)) {
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
								for (const phase of yield* phases.list(task.id, root)) {
									declareRef(phase.data.repo, phase.data.base)
									for (const reference of phase.data.repos ?? [])
										declareRef(reference.repo, reference.ref)
								}
							}
						}
					}

					const repositoryList = gitAvailable
						? yield* repositories.list(root)
						: []
					if (!gitAvailable) {
						add({
							id: "repository.inspection",
							category: "repository",
							level: "warning",
							status: "fail",
							message:
								"Repository, ref, remote, and worktree checks were skipped because Git is unavailable",
							remediation: "Install 'git' and rerun 'agency doctor'.",
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
							const observed = yield* fs.runCommand(
								[
									"git",
									"-C",
									repository.path,
									"ls-remote",
									"origin",
									source.ref,
								],
								{ captureOutput: true },
							)
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
							const local = yield* fs.runCommand(
								[
									"git",
									"-C",
									repository.path,
									"rev-parse",
									"--verify",
									`${ref}^{commit}`,
								],
								{ captureOutput: true },
							)
							const remote =
								local.exitCode === 0
									? local
									: yield* fs.runCommand(
											[
												"git",
												"-C",
												repository.path,
												"rev-parse",
												"--verify",
												`origin/${ref}^{commit}`,
											],
											{ captureOutput: true },
										)
							const found = local.exitCode === 0 || remote.exitCode === 0
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

					if (validation.valid && gitAvailable) {
						const inspected = yield* Effect.either(worktrees.list(root))
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
