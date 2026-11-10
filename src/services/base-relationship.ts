import { Data, Effect } from "effect"
import type { FileSystemService } from "./FileSystemService"

class BaseRelationshipError extends Data.TaggedError("BaseRelationshipError")<{
	readonly message: string
}> {}

interface ForeignBranch {
	readonly ref: string
	readonly commit: string
}

/**
 * Decides whether `head` is built on `baseRevision` without requiring it to
 * contain the base's current tip; being behind the base is normal.
 *
 * - `unrelated`: no merge base exists.
 * - `foreign`: a `candidates` tip (other than `ignore`) is in `base..head`, so
 *   head carries another branch's commits that the base lacks. Tips are matched
 *   against the outgoing commits, so cost scales with those, not with refs.
 * - `based`: otherwise. `behind` counts base commits that head lacks.
 */
export const inspectBaseRelationship = (
	fs: FileSystemService["Service"],
	cwd: string,
	input: {
		readonly head: string
		readonly baseRevision: string
		readonly candidates: readonly string[]
		readonly ignore: readonly string[]
		readonly timeoutMs?: number
	},
) =>
	Effect.gen(function* () {
		const git = (args: readonly string[]) =>
			fs.runCommand(["git", ...args], {
				cwd,
				captureOutput: true,
				timeoutMs: input.timeoutMs ?? 30_000,
			})
		const stdout = (args: readonly string[]) =>
			git(args).pipe(
				Effect.flatMap((result) =>
					result.exitCode === 0
						? Effect.succeed(result.stdout)
						: Effect.fail(
								new BaseRelationshipError({
									message: `git ${args[0]} failed: ${result.stderr.trim()}`,
								}),
							),
				),
			)

		const mergeBase = yield* git(["merge-base", input.head, input.baseRevision])
		if (mergeBase.exitCode === 1) return { kind: "unrelated" as const }
		if (mergeBase.exitCode !== 0)
			return yield* new BaseRelationshipError({
				message: `git merge-base failed: ${mergeBase.stderr.trim()}`,
			})
		const forkPoint = mergeBase.stdout.trim()
		const [behind, outgoing, refs] = yield* Effect.all(
			[
				stdout(["rev-list", "--count", `${input.head}..${input.baseRevision}`]),
				stdout(["rev-list", `${input.baseRevision}..${input.head}`]),
				stdout([
					"for-each-ref",
					"--format=%(objectname)%00%(refname)%00%(symref)",
					...input.candidates,
				]),
			],
			{ concurrency: "unbounded" },
		)
		const refsByCommit = new Map<string, string[]>()
		for (const line of refs.split("\n")) {
			const [commit, ref, symref] = line.split("\0")
			if (!commit || !ref || symref || input.ignore.includes(ref)) continue
			refsByCommit.set(commit, [...(refsByCommit.get(commit) ?? []), ref])
		}
		// rev-list lists the most recent foreign tip first.
		const foreign: ForeignBranch[] = outgoing.split("\n").flatMap((commit) =>
			(refsByCommit.get(commit.trim()) ?? []).map((ref) => ({
				ref,
				commit: commit.trim(),
			})),
		)
		const based = {
			forkPoint,
			behind: Number.parseInt(behind.trim(), 10) || 0,
		}
		return foreign.length > 0
			? { kind: "foreign" as const, ...based, foreign }
			: { kind: "based" as const, ...based }
	})

export const shortRef = (ref: string) =>
	ref.replace(/^refs\/(?:remotes|heads)\//, "")

export const describeForeignBranches = (foreign: readonly ForeignBranch[]) =>
	foreign
		.map(
			(branch) => `'${shortRef(branch.ref)}' (${branch.commit.slice(0, 12)})`,
		)
		.join(", ")
