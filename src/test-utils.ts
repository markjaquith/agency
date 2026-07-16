import { spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileSystemService } from "./services/FileSystemService"
import { WorkbaseService } from "./services/WorkbaseService"
import { RepositoryService } from "./services/RepositoryService"
import { EpicService } from "./services/EpicService"
import { TaskService } from "./services/TaskService"
import { PhaseService } from "./services/PhaseService"
import { WorktreeService } from "./services/WorktreeService"
import { PullRequestService } from "./services/PullRequestService"

export const createTempDir = () => mkdtemp(join(tmpdir(), "agency-test-"))

export const cleanupTempDir = (path: string) =>
	rm(path, { recursive: true, force: true })

const TestLayer = Layer.mergeAll(
	FileSystemService.Default,
	WorkbaseService.Default,
	RepositoryService.Default,
	EpicService.Default,
	TaskService.Default,
	PhaseService.Default,
	WorktreeService.Default,
	PullRequestService.Default,
)

export async function runTestEffect<A, E>(
	effect: Effect.Effect<A, E, any>,
): Promise<A> {
	const program = effect.pipe(
		Effect.provide(TestLayer),
		Effect.catchAllDefect((defect) =>
			Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
		),
	) as Effect.Effect<A, E | Error, never>

	return Effect.runPromise(program)
}

export async function captureLogs(
	run: () => Promise<unknown>,
): Promise<string[]> {
	const logs: string[] = []
	const log = spyOn(console, "log").mockImplementation((...args) => {
		logs.push(args.join(" "))
	})
	try {
		await run()
		return logs
	} finally {
		log.mockRestore()
	}
}
