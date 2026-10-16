import { spyOn } from "bun:test"
import Ajv2020 from "ajv/dist/2020"
import addFormats from "ajv-formats"
import actionSchema from "../schemas/agency-action-v1.schema.json"
import attentionSchema from "../schemas/agency-attention-v1.schema.json"
import { Effect, Layer, Stream } from "effect"
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
import { PushService } from "./services/PushService"
import { RebaseService } from "./services/RebaseService"
import { ArchiveService } from "./services/ArchiveService"
import { IntegrationService } from "./services/IntegrationService"
import { ContextService } from "./services/ContextService"
import { GraphService } from "./services/GraphService"
import { SyncService } from "./services/SyncService"
import { ReadinessService } from "./services/ReadinessService"
import { GraphMutationService } from "./services/GraphMutationService"
import { DoctorService } from "./services/DoctorService"
import { ReviewService } from "./services/ReviewService"
import { TicketService } from "./services/TicketService"
import { RuntimeService } from "./services/RuntimeService"
import { RuntimeBindingService } from "./services/RuntimeBindingService"
import { PullRequestStatusService } from "./services/PullRequestStatusService"
import { SupervisionService } from "./services/SupervisionService"
import type {
	RuntimePane,
	RuntimeProvider,
	RuntimeSnapshot,
} from "./workbase/runtime"
import {
	GitVersionControlService,
	VersionControlService,
} from "./services/VersionControlService"

export const createTempDir = () => mkdtemp(join(tmpdir(), "agency-test-"))

export const cleanupTempDir = (path: string) =>
	rm(path, { recursive: true, force: true })

export const trackDocumentReadConcurrency = (
	fs: FileSystemService["Service"],
) => {
	let active = 0
	let maximum = 0
	return {
		fs: {
			...fs,
			readFile: (path: string) => {
				if (!/(?:EPIC|TASK|PHASE)\.md$/.test(path)) return fs.readFile(path)
				return Effect.gen(function* () {
					active += 1
					maximum = Math.max(maximum, active)
					yield* Effect.sleep(5)
					return yield* fs.readFile(path)
				}).pipe(Effect.ensuring(Effect.sync(() => (active -= 1))))
			},
		} satisfies FileSystemService["Service"],
		maximum: () => maximum,
	}
}

const TestLayer = Layer.mergeAll(
	FileSystemService.layer,
	WorkbaseService.layer,
	GitVersionControlService.layer,
	VersionControlService.layer,
	RepositoryService.layer,
	EpicService.layer,
	TaskService.layer,
	PhaseService.layer,
	WorktreeService.layer,
	PullRequestService.layer,
	PushService.layer,
	RebaseService.layer,
	ArchiveService.layer,
	IntegrationService.layer,
	ContextService.layer,
	GraphService.layer,
	SyncService.layer,
	ReadinessService.layer,
	GraphMutationService.layer,
	DoctorService.layer,
	ReviewService.layer,
	TicketService.layer,
	RuntimeBindingService.layer,
	PullRequestStatusService.layer,
	SupervisionService.layer,
	// Tests never observe a real runtime unless they provide one explicitly.
	Layer.succeed(RuntimeService, fakeRuntimeService(null)),
)

export async function runTestEffect<A, E>(
	effect: Effect.Effect<A, E, any>,
): Promise<A> {
	const program = effect.pipe(
		Effect.provide(TestLayer),
		Effect.catchDefect((defect) =>
			Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
		),
	) as Effect.Effect<A, E | Error, never>

	return Effect.runPromise(program)
}

async function captureConsole(
	method: "log" | "error",
	run: () => Promise<unknown>,
): Promise<string[]> {
	const logs: string[] = []
	const output = spyOn(console, method).mockImplementation((...args) => {
		logs.push(args.join(" "))
	})
	try {
		await run()
		return logs
	} finally {
		output.mockRestore()
	}
}

export const captureLogs = (run: () => Promise<unknown>) =>
	captureConsole("log", run)

export const captureErrors = (run: () => Promise<unknown>) =>
	captureConsole("error", run)

export const runtimePane = (
	fields: Partial<RuntimePane> & Pick<RuntimePane, "paneId">,
): RuntimePane => ({
	tabId: "w1:t1",
	workspaceId: "w1",
	agent: "opencode",
	agentSessionId: null,
	agentStatus: "idle",
	cwd: null,
	foregroundCwd: null,
	terminalTitle: null,
	focused: false,
	...fields,
})

/** An in-memory runtime provider; no real runtime is contacted. */
export const createFakeRuntimeProvider = (options: {
	readonly panes?: readonly RuntimePane[]
	readonly location?: ReturnType<RuntimeProvider["currentLocation"]>
	readonly transcripts?: Readonly<Record<string, string>>
}): RuntimeProvider => {
	const snapshot: RuntimeSnapshot = {
		runtime: "herdr",
		workspaces: [],
		tabs: [],
		panes: options.panes ?? [],
	}
	return {
		kind: "herdr",
		currentLocation: () => options.location ?? null,
		snapshot: () => Effect.succeed(snapshot),
		readTranscript: (paneId) =>
			Effect.succeed(options.transcripts?.[paneId] ?? ""),
		waitForAgentStatus: (paneId, statuses) =>
			Effect.succeed(
				snapshot.panes.find(
					(pane) =>
						pane.paneId === paneId && statuses.includes(pane.agentStatus),
				) ?? null,
			),
		subscribe: () => Stream.empty,
	}
}

export function fakeRuntimeService(
	provider: RuntimeProvider | null,
): RuntimeService["Service"] {
	return { provider: () => Effect.succeed(provider) }
}

/** JSON Schema validators for the published action and attention contracts. */
export const attentionValidators = () => {
	const ajv = new Ajv2020({ allErrors: true, strict: false })
	addFormats(ajv)
	ajv.addSchema(actionSchema)
	return {
		action: ajv.getSchema(actionSchema.$id)!,
		report: ajv.compile(attentionSchema),
	}
}
