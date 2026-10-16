import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FileSystemService } from "./FileSystemService"
import { PullRequestStatusService } from "./PullRequestStatusService"

const url = "https://github.com/acme/app/pull/1"

const withGh = <A>(
	respond: (argv: readonly string[]) => {
		readonly exitCode: number
		readonly stdout: string
	},
	use: (
		service: PullRequestStatusService["Service"],
	) => Effect.Effect<A, never, FileSystemService>,
) => {
	const calls: (readonly string[])[] = []
	return Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystemService
			const service = yield* PullRequestStatusService.make
			const result = yield* use(service).pipe(
				Effect.provideService(FileSystemService, {
					...fs,
					runCommand: (argv: readonly string[]) =>
						Effect.sync(() => {
							calls.push(argv)
							return { stderr: "", ...respond(argv) }
						}),
				} as FileSystemService["Service"]),
			)
			return { result, calls }
		}).pipe(Effect.provide(FileSystemService.layer)),
	)
}

const read = async (fields: Record<string, unknown> | string) =>
	(
		await withGh(
			() => ({
				exitCode: 0,
				stdout:
					typeof fields === "string"
						? fields
						: JSON.stringify({ state: "OPEN", isDraft: false, ...fields }),
			}),
			(service) => service.read(url),
		)
	).result

describe("live pull request status", () => {
	test("summarizes approval, checks, and mergeability", async () => {
		expect(
			await read({
				reviewDecision: "APPROVED",
				mergeable: "MERGEABLE",
				mergeStateStatus: "CLEAN",
				headRefOid: "abc123",
				statusCheckRollup: [
					{
						__typename: "CheckRun",
						status: "COMPLETED",
						conclusion: "SUCCESS",
					},
					{
						__typename: "CheckRun",
						status: "COMPLETED",
						conclusion: "SKIPPED",
					},
					{ __typename: "StatusContext", state: "SUCCESS" },
				],
			}),
		).toEqual({
			state: "available",
			url,
			prState: "open",
			draft: false,
			review: "approved",
			checks: "passing",
			mergeable: "mergeable",
			mergeState: "CLEAN",
			headSha: "abc123",
		})
	})

	test("reports failing and pending checks", async () => {
		expect(
			await read({
				statusCheckRollup: [
					{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
					{
						__typename: "CheckRun",
						status: "COMPLETED",
						conclusion: "FAILURE",
					},
				],
			}),
		).toMatchObject({ checks: "failing" })
		expect(
			await read({
				statusCheckRollup: [{ __typename: "StatusContext", state: "PENDING" }],
			}),
		).toMatchObject({ checks: "pending" })
		expect(await read({ statusCheckRollup: [] })).toMatchObject({
			checks: "none",
		})
	})

	test("falls back to latest reviews when no decision is required", async () => {
		expect(
			await read({
				reviewDecision: "",
				latestReviews: [{ state: "APPROVED" }],
			}),
		).toMatchObject({ review: "approved" })
		expect(
			await read({
				reviewDecision: "",
				latestReviews: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }],
			}),
		).toMatchObject({ review: "changes_requested" })
		expect(await read({})).toMatchObject({
			review: "none",
			mergeable: "unknown",
		})
	})

	test("reports merged state and unusable output", async () => {
		expect(await read({ state: "MERGED" })).toMatchObject({
			prState: "merged",
		})
		expect(await read("nope")).toEqual({
			state: "unavailable",
			url,
			reason: "gh returned invalid JSON",
		})
		expect(await read("{}")).toMatchObject({ state: "unavailable" })
	})

	test("shares concurrent reads and resolves the merge method", async () => {
		const { result, calls } = await withGh(
			(argv) => ({
				exitCode: 0,
				stdout:
					argv[1] === "repo"
						? '{"viewerDefaultMergeMethod":"SQUASH"}'
						: '{"state":"OPEN","isDraft":false}',
			}),
			(service) =>
				Effect.all(
					[
						service.read(url),
						service.read(url),
						service.mergeMethod("acme/app"),
					],
					{ concurrency: "unbounded" },
				),
		)
		expect(result[2]).toBe("squash")
		expect(calls.filter((argv) => argv[1] === "pr")).toHaveLength(1)
	})

	test("defaults the merge method when gh fails", async () => {
		const { result } = await withGh(
			() => ({ exitCode: 1, stdout: "" }),
			(service) => service.mergeMethod("acme/app"),
		)
		expect(result).toBe("merge")
	})
})
