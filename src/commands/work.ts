import { Effect } from "effect"
import type { BaseCommandOptions } from "../utils/command"
import { WorktreeService } from "../services/WorktreeService"
import { FileSystemService } from "../services/FileSystemService"
import { createLoggers } from "../utils/effect"
import { execvp } from "../utils/exec"

interface WorkOptions extends BaseCommandOptions {
	readonly taskId?: string
	readonly phaseId?: string
	readonly opencode?: boolean
	readonly claude?: boolean
}

type LaunchAgent = (cli: string, args: readonly string[], cwd: string) => void

const launchAgent: LaunchAgent = (cli, args, cwd) => {
	process.chdir(cwd)
	execvp(cli, [...args])
}

export const work = (
	options: WorkOptions = {},
	launch: LaunchAgent = launchAgent,
) =>
	Effect.gen(function* () {
		if (!options.taskId) {
			return yield* Effect.fail(new Error("Task ID is required"))
		}
		if (options.opencode && options.claude) {
			return yield* Effect.fail(
				new Error("Cannot use both --opencode and --claude"),
			)
		}

		const worktrees = yield* WorktreeService
		const fs = yield* FileSystemService
		const { verboseLog } = createLoggers(options)
		const workspace = yield* worktrees.materialize(
			options.taskId,
			options.phaseId,
			options.cwd ?? process.cwd(),
		)
		const prompt = workspace.phasePath
			? `Start the task. Read ${workspace.taskPath} and ${workspace.phasePath}.`
			: `Start the task. Read ${workspace.taskPath}.`

		const requested = options.claude ? "claude" : "opencode"
		let cli = requested
		let available = yield* fs.runCommand(["which", cli], {
			captureOutput: true,
		})
		if (available.exitCode !== 0 && !options.opencode && !options.claude) {
			cli = "claude"
			available = yield* fs.runCommand(["which", cli], { captureOutput: true })
		}
		if (available.exitCode !== 0) {
			return yield* Effect.fail(new Error(`${cli} CLI tool not found`))
		}

		verboseLog(`Launching ${cli} in ${workspace.writablePath}`)
		const args = cli === "opencode" ? ["--prompt", prompt] : [prompt]
		launch(cli, [cli, ...args], workspace.writablePath)
	})

export const help = `
Usage: agency work <task-id> [phase-id]

Materialize repository worktrees and launch an agent in the writable checkout.

Options:
  --opencode           Require OpenCode
  --claude             Require Claude Code
`
