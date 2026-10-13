import { Effect } from "effect"
import type { FileSystemService } from "./FileSystemService"

/**
 * Whether `commit` is reachable from any reflog entry of the local branch, so
 * its history was integrated locally at some point. Returns null when the branch
 * has no usable reflog and the check cannot be made.
 */
export const reflogIncludes = (
	fs: FileSystemService["Service"],
	cwd: string,
	branch: string,
	commit: string,
) =>
	Effect.gen(function* () {
		const reflog = yield* fs.runCommand(
			["git", "log", "--walk-reflogs", "--format=%H", `refs/heads/${branch}`],
			{ cwd, captureOutput: true, timeoutMs: 10_000 },
		)
		if (reflog.exitCode !== 0) return null
		const entries = [
			...new Set(
				reflog.stdout
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean),
			),
		]
		if (entries.length === 0) return null
		if (entries.includes(commit)) return true
		const outside = yield* fs.runCommand(
			["git", "rev-list", "-1", commit, "--not", ...entries],
			{ cwd, captureOutput: true, timeoutMs: 10_000 },
		)
		return outside.exitCode === 0 && outside.stdout.trim() === ""
	})

export const integrateRemoteRemediation = (remote: string, branch: string) =>
	`Integrate the remote commits first (for example: git fetch ${remote} ${branch} && git rebase ${remote}/${branch}), then retry. Do not discard them with a raw git push --force.`
