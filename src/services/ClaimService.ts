import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { randomUUID } from "node:crypto"
import {
	open,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { PhaseService } from "./PhaseService"
import { TaskService } from "./TaskService"
import { WorkbaseService } from "./WorkbaseService"
import { FileSystemService } from "./FileSystemService"
import {
	documentRevision,
	isDocumentRevision,
	RevisionConflictError,
} from "../workbase/document-revision"
import {
	formatMarkdownDocument,
	parseFrontmatterSync,
} from "../workbase/frontmatter"
import {
	PhaseFrontmatter,
	TaskFrontmatter,
	type ClaimRecord,
	type PullRequestRecord,
	type PhaseFrontmatter as PhaseData,
	type TaskFrontmatter as TaskData,
} from "../workbase/schemas"

class ClaimError extends Data.TaggedError("ClaimError")<{
	readonly message: string
	readonly target?: string
}> {}

class ClaimConflictError extends Data.TaggedError("ClaimConflictError")<{
	readonly message: string
	readonly target: string
	readonly currentRevision: string
	readonly claim?: ClaimRecord
	readonly legacyStatus?: "working" | "delegated"
}> {}

class ClaimOwnershipError extends Data.TaggedError("ClaimOwnershipError")<{
	readonly message: string
	readonly target: string
	readonly currentRevision: string
	readonly sessionId: string
	readonly claim?: ClaimRecord
}> {}

interface ClaimTarget {
	readonly kind: "task" | "phase"
	readonly root: string
	readonly taskId: string
	readonly phaseId?: string
	readonly path: string
	readonly label: string
}

interface ClaimInput {
	readonly taskId: string
	readonly phaseId?: string
	readonly claimant: string
	readonly runner: string
	readonly sessionId: string
	readonly revision: string
	readonly expiresAt?: string
	readonly now?: Date
}

interface OwnedClaimInput {
	readonly taskId: string
	readonly phaseId?: string
	readonly sessionId: string
	readonly revision: string
	readonly now?: Date
}

interface FinishInput extends OwnedClaimInput {
	readonly outcome: "done" | "dropped"
}

interface ExpireClaimInput {
	readonly taskId: string
	readonly phaseId?: string
	readonly revision: string
	readonly now?: Date
}

interface ReconcileInput {
	readonly taskId: string
	readonly phaseId?: string
	readonly revision: string
	readonly pr?: string | PullRequestRecord
	readonly status?: "done"
}

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/

type SingleTaskData = Extract<TaskData, { readonly repo: string }>
type ReviewTaskData = Extract<TaskData, { readonly review: unknown }>
type ExecutionData = SingleTaskData | ReviewTaskData | PhaseData

const isTaggedClaimError = (
	error: unknown,
): error is
	| ClaimError
	| RevisionConflictError
	| ClaimConflictError
	| ClaimOwnershipError =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	typeof error._tag === "string" &&
	[
		"ClaimError",
		"RevisionConflictError",
		"ClaimConflictError",
		"ClaimOwnershipError",
	].includes(error._tag)

const decodeExecution = (target: ClaimTarget, input: unknown) => {
	const schema: Schema.Schema<any> =
		target.kind === "task" ? TaskFrontmatter : PhaseFrontmatter
	const result = Schema.decodeUnknownEither(schema, {
		errors: "all",
		onExcessProperty: "error",
	})(input)
	if (Either.isLeft(result)) {
		throw new ClaimError({
			target: target.label,
			message: TreeFormatter.formatErrorSync(result.left),
		})
	}
	if (target.kind === "task" && "phases" in result.right) {
		throw new ClaimError({
			target: target.label,
			message: `Task '${target.taskId}' has multiple phases; claim a phase instead`,
		})
	}
	return result.right as ExecutionData
}

const assertRevision = (revision: string) => {
	if (!isDocumentRevision(revision)) {
		throw new ClaimError({
			message: "Revision must be a 64-character SHA-256 hash",
		})
	}
}

const assertIdentity = (label: string, value: string) => {
	if (!value.trim())
		throw new ClaimError({ message: `${label} must not be empty` })
}

const isIsoTimestamp = (value: string) =>
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
	Number.isFinite(Date.parse(value))

const isUnexpired = (claim: ClaimRecord, now: Date) =>
	claim.state === "active" &&
	(claim.expiresAt === undefined || Date.parse(claim.expiresAt) > now.getTime())

const acquireLock = async (lockPath: string, label: string) => {
	for (let attempt = 0; attempt < 1_750; attempt += 1) {
		try {
			const handle = await open(lockPath, "wx")
			return { handle, lockPath }
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "EEXIST"
			) {
				throw error
			}
			try {
				const lock = await stat(lockPath)
				if (Date.now() - lock.mtimeMs > 30_000) await unlink(lockPath)
			} catch {
				// Another process released the lock between checks.
			}
			await Bun.sleep(20)
		}
	}
	throw new ClaimError({ message: `Timed out waiting to update ${label}` })
}

const updateAtomically = async <T>(
	target: ClaimTarget,
	expectedRevision: string,
	update: (
		data: ExecutionData,
		now: Date,
	) => T & {
		readonly data: ExecutionData
	},
	now: Date,
) => {
	assertRevision(expectedRevision)
	const graphLock = await acquireLock(
		join(target.root, ".agency-graph-mutation.lock"),
		target.root,
	)
	let documentLock: Awaited<ReturnType<typeof acquireLock>> | undefined
	let temporaryPath: string | undefined
	try {
		documentLock = await acquireLock(`${target.path}.claim.lock`, target.path)
		const content = await readFile(target.path, "utf8")
		const currentRevision = documentRevision(content)
		const parsed = parseFrontmatterSync(content, target.path)
		const current = decodeExecution(target, parsed.data)
		if (currentRevision !== expectedRevision) {
			throw new RevisionConflictError({
				path: relative(target.root, target.path),
				target: target.label,
				expectedRevision,
				currentRevision,
				claim: current.claim,
				message: `Revision conflict for ${target.label}`,
			})
		}
		const result = update(current, now)
		const updatedContent = formatMarkdownDocument(result.data, parsed.body)
		temporaryPath = join(
			dirname(target.path),
			`.${basename(target.path)}.${process.pid}.${randomUUID()}.tmp`,
		)
		await writeFile(temporaryPath, updatedContent, { flag: "wx" })
		await rename(temporaryPath, target.path)
		temporaryPath = undefined
		return {
			...result,
			target: target.label,
			previousRevision: currentRevision,
			revision: documentRevision(updatedContent),
		}
	} finally {
		if (temporaryPath) await unlink(temporaryPath).catch(() => undefined)
		await documentLock?.handle.close().catch(() => undefined)
		if (documentLock) await unlink(documentLock.lockPath).catch(() => undefined)
		await graphLock.handle.close().catch(() => undefined)
		await unlink(graphLock.lockPath).catch(() => undefined)
	}
}

const operation = <T>(run: () => Promise<T>) =>
	Effect.tryPromise({
		try: run,
		catch: (error) =>
			isTaggedClaimError(error)
				? error
				: new ClaimError({
						message: error instanceof Error ? error.message : String(error),
					}),
	})

export class ClaimService extends Effect.Service<ClaimService>()(
	"ClaimService",
	{
		sync: () => ({
			inspect: (
				taskId: string,
				phaseId?: string,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const tasks = yield* TaskService
					const phases = yield* PhaseService
					const root = yield* workbase.discover(startPath)
					const task = yield* tasks.show(taskId, root)
					const phase = phaseId
						? yield* phases.show(task.id, phaseId, root)
						: undefined
					const target: ClaimTarget = phaseId
						? {
								kind: "phase",
								root,
								taskId: task.id,
								phaseId,
								path: phase!.path,
								label: `phase '${task.id}/${phaseId}'`,
							}
						: {
								kind: "task",
								root,
								taskId: task.id,
								path: task.path,
								label: `task '${task.id}'`,
							}
					if (!phaseId && "phases" in task.data) {
						return yield* new ClaimError({
							target: target.label,
							message: `Task '${task.id}' has multiple phases; claim a phase instead`,
						})
					}
					const content = yield* fs.readFile(target.path)
					const parsed = parseFrontmatterSync(content, target.path)
					return {
						target,
						revision: documentRevision(content),
						data: decodeExecution(target, parsed.data),
					}
				}),

			expire: (input: ExpireClaimInput, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const service = yield* ClaimService
					const inspected = yield* service.inspect(
						input.taskId,
						input.phaseId,
						startPath,
					)
					return yield* operation(() =>
						updateAtomically(
							inspected.target,
							input.revision,
							(data, now) => {
								if (
									data.claim?.state !== "active" ||
									data.claim.expiresAt === undefined ||
									Date.parse(data.claim.expiresAt) > now.getTime() ||
									(data.status !== "working" && data.status !== "delegated")
								) {
									throw new ClaimError({
										target: inspected.target.label,
										message: `${inspected.target.label} does not have an expired active claim`,
									})
								}
								const claim: ClaimRecord = {
									...data.claim,
									state: "released",
									releasedAt: now.toISOString(),
								}
								return { data: { ...data, status: "open", claim }, claim }
							},
							input.now ?? new Date(),
						),
					)
				}),

			reconcile: (input: ReconcileInput, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					if (
						typeof input.pr === "string" &&
						input.pr !== undefined &&
						!PR_URL.test(input.pr)
					) {
						return yield* new ClaimError({
							message: `Invalid GitHub pull request URL: ${input.pr}`,
						})
					}
					const service = yield* ClaimService
					const inspected = yield* service.inspect(
						input.taskId,
						input.phaseId,
						startPath,
					)
					return yield* operation(() =>
						updateAtomically(
							inspected.target,
							input.revision,
							(data) => {
								if (input.status === "done" && data.claim?.state === "active") {
									throw new ClaimConflictError({
										target: inspected.target.label,
										currentRevision: input.revision,
										claim: data.claim,
										message: `${inspected.target.label} has an active claim`,
									})
								}
								return {
									data: {
										...data,
										...(input.pr !== undefined ? { pr: input.pr } : {}),
										...(input.status !== undefined
											? { status: input.status }
											: {}),
									},
								}
							},
							new Date(),
						),
					)
				}),

			claim: (input: ClaimInput, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					for (const [label, value] of [
						["Claimant", input.claimant],
						["Runner", input.runner],
						["Session ID", input.sessionId],
					] as const) {
						assertIdentity(label, value)
					}
					const service = yield* ClaimService
					const inspected = yield* service.inspect(
						input.taskId,
						input.phaseId,
						startPath,
					)
					const now = input.now ?? new Date()
					if (
						input.expiresAt !== undefined &&
						(!isIsoTimestamp(input.expiresAt) ||
							Date.parse(input.expiresAt) <= now.getTime())
					) {
						return yield* new ClaimError({
							message: "Claim expiry must be a future ISO-8601 timestamp",
						})
					}
					return yield* operation(() =>
						updateAtomically(
							inspected.target,
							input.revision,
							(data, operationTime) => {
								const replacingExpiredClaim =
									data.claim?.state === "active" &&
									!isUnexpired(data.claim, operationTime)
								if (data.claim && isUnexpired(data.claim, operationTime)) {
									throw new ClaimConflictError({
										target: inspected.target.label,
										currentRevision: input.revision,
										claim: data.claim,
										message: `${inspected.target.label} is claimed by '${data.claim.runner}'`,
									})
								}
								if (
									!data.claim &&
									(data.status === "working" || data.status === "delegated")
								) {
									throw new ClaimConflictError({
										target: inspected.target.label,
										currentRevision: input.revision,
										legacyStatus: data.status,
										message: `${inspected.target.label} has legacy '${data.status}' ownership; reopen it before claiming`,
									})
								}
								if (data.status !== "open" && !replacingExpiredClaim) {
									throw new ClaimError({
										target: inspected.target.label,
										message: `${inspected.target.label} cannot be claimed while ${data.status}`,
									})
								}
								const claim: ClaimRecord = {
									claimant: input.claimant.trim(),
									runner: input.runner.trim(),
									sessionId: input.sessionId.trim(),
									startedAt: operationTime.toISOString(),
									targetRevision: input.revision,
									...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
									state: "active",
								}
								return { data: { ...data, status: "working", claim }, claim }
							},
							now,
						),
					)
				}),

			release: (input: OwnedClaimInput, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					assertIdentity("Session ID", input.sessionId)
					const service = yield* ClaimService
					const inspected = yield* service.inspect(
						input.taskId,
						input.phaseId,
						startPath,
					)
					return yield* operation(() =>
						updateAtomically(
							inspected.target,
							input.revision,
							(data, now) => {
								if (
									!data.claim ||
									data.claim.state !== "active" ||
									data.claim.sessionId !== input.sessionId
								) {
									throw new ClaimOwnershipError({
										target: inspected.target.label,
										currentRevision: input.revision,
										sessionId: input.sessionId,
										claim: data.claim,
										message: `Session '${input.sessionId}' does not own ${inspected.target.label}`,
									})
								}
								const claim: ClaimRecord = {
									...data.claim,
									state: "released",
									releasedAt: now.toISOString(),
								}
								return { data: { ...data, status: "open", claim }, claim }
							},
							input.now ?? new Date(),
						),
					)
				}),

			finish: (input: FinishInput, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					assertIdentity("Session ID", input.sessionId)
					const service = yield* ClaimService
					const inspected = yield* service.inspect(
						input.taskId,
						input.phaseId,
						startPath,
					)
					return yield* operation(() =>
						updateAtomically(
							inspected.target,
							input.revision,
							(data, now) => {
								if (
									!data.claim ||
									data.claim.state !== "active" ||
									data.claim.sessionId !== input.sessionId
								) {
									throw new ClaimOwnershipError({
										target: inspected.target.label,
										currentRevision: input.revision,
										sessionId: input.sessionId,
										claim: data.claim,
										message: `Session '${input.sessionId}' does not own ${inspected.target.label}`,
									})
								}
								const claim: ClaimRecord = {
									...data.claim,
									state: "finished",
									finishedAt: now.toISOString(),
									outcome: input.outcome,
								}
								return {
									data: { ...data, status: input.outcome, claim },
									claim,
								}
							},
							input.now ?? new Date(),
						),
					)
				}),
		}),
	},
) {}
