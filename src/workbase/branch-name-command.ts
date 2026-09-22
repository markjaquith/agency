import { Effect } from "effect"
import { FileSystemService } from "../services/FileSystemService"
import { WorkbaseService } from "../services/WorkbaseService"
import {
	expandBranchNameCommand,
	type BranchNameVariables,
} from "./branch-name-template"

const TIMEOUT_MS = 120_000

const commandEnvironment = (
	variables: BranchNameVariables,
): Record<string, string> =>
	Object.fromEntries(
		Object.entries(variables).map(([name, value]) => [
			`AGENCY_${name.replaceAll(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`,
			value,
		]),
	)

interface ResolveBranchNameInput {
	readonly id: string
	readonly taskId: string
	readonly phaseId?: string
	readonly ticketUrl?: string | null
	readonly repo: string
	readonly base: string
	readonly defaultBranch: string
	readonly startPath?: string
}

export const resolveBranchName = (input: ResolveBranchNameInput) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService
		const { root, config } = yield* workbase.loadConfig(
			input.startPath ?? process.cwd(),
		)
		if (!config.branchNameCommand) return input.defaultBranch

		const variables: BranchNameVariables = {
			id: input.id,
			ticket: input.ticketUrl || input.id,
			ticketUrl: input.ticketUrl || "",
			repo: input.repo,
			base: input.base,
			workbaseRoot: root,
			taskId: input.taskId,
			phaseId: input.phaseId ?? "",
		}
		const command = expandBranchNameCommand(config.branchNameCommand, variables)
		const result = yield* fs
			.runCommand(command, {
				cwd: root,
				captureOutput: true,
				env: commandEnvironment(variables),
				timeoutMs: TIMEOUT_MS,
			})
			.pipe(
				Effect.mapError(
					(error) =>
						new Error(
							`branchNameCommand could not run: ${error.cause instanceof Error ? error.cause.message : error.message}`,
						),
				),
			)
		if (result.exitCode !== 0) {
			return yield* Effect.fail(
				new Error(
					`branchNameCommand failed with exit code ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ""}`,
				),
			)
		}
		const branch = result.stdout.trim()
		if (!branch) {
			return yield* Effect.fail(
				new Error("branchNameCommand produced an empty branch name"),
			)
		}
		const checked = yield* fs.runCommand(
			["git", "check-ref-format", "--branch", branch],
			{ cwd: root, captureOutput: true },
		)
		if (checked.exitCode !== 0) {
			return yield* Effect.fail(
				new Error(
					`branchNameCommand produced invalid Git branch name '${branch}'`,
				),
			)
		}
		return branch
	})
