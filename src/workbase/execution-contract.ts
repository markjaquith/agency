import { Schema, TreeFormatter } from "@effect/schema"
import { Effect, Either } from "effect"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { FileSystemService } from "../services/FileSystemService"
import { WorkbaseService } from "../services/WorkbaseService"
import { documentRevision } from "./document-revision"

export const EXECUTION_CONTRACT_VERSION = 1 as const

export const EXECUTION_SOURCE_LOCATIONS = [
	"src/commands/task.ts",
	"src/workbase/execution-contract.ts",
	"src/commands/work.ts",
	"src/services/WorktreeService.ts",
	"src/workbase/AGENTS.md",
] as const

export const RecalledTaskContext = Schema.Struct({
	repo: Schema.optional(Schema.String),
	base: Schema.optional(Schema.String),
	preferredSlug: Schema.String,
	authoritativeSources: Schema.Array(Schema.String),
})

export type RecalledTaskContext = Schema.Schema.Type<typeof RecalledTaskContext>

const ValidationEvidencePayload = Schema.Struct({
	version: Schema.Literal(EXECUTION_CONTRACT_VERSION),
	workbaseRoot: Schema.String,
	target: Schema.String,
	documentPath: Schema.String,
	documentRevision: Schema.String,
	workbaseRevision: Schema.String,
	configRevision: Schema.String,
	repositoryMappingRevision: Schema.String,
	valid: Schema.Literal(true),
	recalledContext: RecalledTaskContext,
})

export const ValidationEvidence = Schema.Struct({
	...ValidationEvidencePayload.fields,
	digest: Schema.String,
})

export type ValidationEvidence = Schema.Schema.Type<typeof ValidationEvidence>

export type EvidenceDisposition =
	| { readonly status: "reused"; readonly reasons: readonly [] }
	| {
			readonly status: "refreshed"
			readonly reasons: readonly string[]
	  }

const digest = (value: unknown) => documentRevision(JSON.stringify(value))

const validateSource = (source: string) => {
	if (!source.trim()) throw new Error("Authoritative source cannot be empty")
	if (isAbsolute(source)) return source
	try {
		const url = new URL(source)
		if (url.protocol === "https:" || url.protocol === "http:") return source
	} catch {}
	throw new Error(
		`Authoritative source '${source}' must be an absolute path or HTTP(S) URL`,
	)
}

export const normalizeRecalledContext = (input: {
	readonly id: string
	readonly repo?: string
	readonly base?: string
	readonly preferredSlug?: string
	readonly authoritativeSources?: readonly string[]
}): RecalledTaskContext => {
	if (input.repo !== undefined && !input.repo.trim()) {
		throw new Error("Recalled repository cannot be empty")
	}
	if (input.base !== undefined && !input.base.trim()) {
		throw new Error("Recalled base cannot be empty")
	}
	if (input.preferredSlug !== undefined && !input.preferredSlug.trim()) {
		throw new Error("Recalled task slug cannot be empty")
	}
	if (input.preferredSlug && input.preferredSlug !== input.id) {
		throw new Error(
			`Recalled task slug '${input.preferredSlug}' conflicts with task ID '${input.id}'`,
		)
	}
	return {
		...(input.repo ? { repo: input.repo } : {}),
		...(input.base ? { base: input.base } : {}),
		preferredSlug: input.id,
		authoritativeSources: [...(input.authoritativeSources ?? [])]
			.map(validateSource)
			.sort(),
	}
}

const workbaseIdentity = (startPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const workbase = yield* WorkbaseService
		const root = yield* workbase.discover(startPath)
		const configPath = join(root, "agency.json")
		const configContent = yield* fs.readFile(configPath)
		const { config } = yield* workbase.loadConfig(root)
		const documents: Array<readonly [string, string]> = []

		const collect = (directory: string, filename: string) =>
			Effect.gen(function* () {
				if (!(yield* fs.isDirectory(directory))) return
				for (const entry of (yield* fs.readDirectory(directory)).sort((a, b) =>
					a.name.localeCompare(b.name),
				)) {
					if (!entry.isDirectory) continue
					const path = join(directory, entry.name, filename)
					if (yield* fs.exists(path))
						documents.push([path, yield* fs.readFile(path)])
				}
			})

		yield* collect(join(root, "epics"), "EPIC.md")
		yield* collect(join(root, "tasks"), "TASK.md")
		const tasksDirectory = join(root, "tasks")
		if (yield* fs.isDirectory(tasksDirectory)) {
			for (const task of yield* fs.readDirectory(tasksDirectory)) {
				if (task.isDirectory) {
					yield* collect(join(tasksDirectory, task.name, "phases"), "PHASE.md")
				}
			}
		}
		documents.sort(([left], [right]) => left.localeCompare(right))
		const aliases = yield* workbase.repositoryAliases(root)
		const materializedMappings: Array<readonly [string, string | null]> = []
		for (const alias of aliases) {
			const path = join(root, "repos", alias)
			materializedMappings.push([
				alias,
				(yield* fs.exists(path)) ? yield* fs.realPath(path) : null,
			])
		}
		return {
			root,
			configRevision: documentRevision(configContent),
			repositoryMappingRevision: digest({
				repositories: config.repositories ?? {},
				aliases,
				materializedMappings,
			}),
			workbaseRevision: digest(
				documents.map(([path, content]) => [
					path.slice(root.length),
					digest(content),
				]),
			),
		}
	})

export const buildValidationEvidence = (input: {
	readonly startPath: string
	readonly target: string
	readonly documentPath: string
	readonly documentRevision: string
	readonly recalledContext: RecalledTaskContext
}) =>
	Effect.gen(function* () {
		const identity = yield* workbaseIdentity(input.startPath)
		const payload = {
			version: EXECUTION_CONTRACT_VERSION,
			workbaseRoot: identity.root,
			target: input.target,
			documentPath: resolve(input.documentPath),
			documentRevision: input.documentRevision,
			workbaseRevision: identity.workbaseRevision,
			configRevision: identity.configRevision,
			repositoryMappingRevision: identity.repositoryMappingRevision,
			valid: true as const,
			recalledContext: input.recalledContext,
		}
		return { ...payload, digest: digest(payload) } satisfies ValidationEvidence
	})

export const parseValidationEvidence = (value: unknown): ValidationEvidence => {
	const decoded = Schema.decodeUnknownEither(ValidationEvidence, {
		errors: "all",
		onExcessProperty: "error",
	})(value)
	if (Either.isLeft(decoded)) {
		throw new Error(
			`Invalid validation evidence: ${TreeFormatter.formatErrorSync(decoded.left)}`,
		)
	}
	return decoded.right
}

export const readValidationEvidence = (input: string, cwd: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const trimmed = input.trim()
		const content = trimmed.startsWith("{")
			? trimmed
			: yield* fs.readFile(resolve(cwd, trimmed))
		try {
			const parsed = JSON.parse(content)
			const candidate =
				parsed?.result?.validationEvidence?.evidence ??
				parsed?.result?.evidence ??
				parsed?.validationEvidence?.evidence ??
				parsed?.evidence ??
				(parsed?.target && parsed?.documentRevision ? parsed : undefined)
			if (!candidate || candidate.version !== EXECUTION_CONTRACT_VERSION) {
				return undefined
			}
			return parseValidationEvidence(candidate)
		} catch (cause) {
			return yield* Effect.fail(
				cause instanceof Error ? cause : new Error(String(cause)),
			)
		}
	})

export const assessValidationEvidence = (input: {
	readonly evidence?: ValidationEvidence
	readonly startPath: string
	readonly target: string
	readonly documentPath: string
	readonly documentRevision: string
}) =>
	Effect.gen(function* () {
		const identity = yield* workbaseIdentity(input.startPath)
		const evidence = input.evidence
		const reasons: string[] = []
		if (!evidence) reasons.push("not-supplied")
		else {
			const { digest: evidenceDigest, ...payload } = evidence
			if (digest(payload) !== evidenceDigest) reasons.push("digest-mismatch")
			if (evidence.workbaseRoot !== identity.root)
				reasons.push("workbase-mismatch")
			if (evidence.target !== input.target) reasons.push("target-mismatch")
			if (evidence.documentPath !== resolve(input.documentPath))
				reasons.push("document-path-mismatch")
			if (evidence.documentRevision !== input.documentRevision)
				reasons.push("document-revision-changed")
			if (evidence.workbaseRevision !== identity.workbaseRevision)
				reasons.push("workbase-revision-changed")
			if (evidence.configRevision !== identity.configRevision)
				reasons.push("configuration-changed")
			if (
				evidence.repositoryMappingRevision !==
				identity.repositoryMappingRevision
			)
				reasons.push("repository-mapping-changed")
		}
		return {
			identity,
			disposition: reasons.length
				? ({ status: "refreshed", reasons } as const)
				: ({ status: "reused", reasons: [] } as const),
		}
	})

export const buildExecutionContract = (input: {
	readonly workbaseRoot: string
	readonly target: string
	readonly taskPath: string
	readonly phasePath?: string | null
	readonly checkoutPath?: string | null
	readonly documentRevision: string
	readonly dryRun: boolean
}) => {
	const executionDirectory = dirname(input.phasePath ?? input.taskPath)
	const key = digest({
		version: EXECUTION_CONTRACT_VERSION,
		workbaseRoot: input.workbaseRoot,
		target: input.target,
	})
	const documentPath = input.phasePath ?? input.taskPath
	const mode = input.dryRun ? "preview" : "applied"
	return {
		version: EXECUTION_CONTRACT_VERSION,
		capability: "agency-execution-v1" as const,
		mode,
		executionIdentity: {
			key,
			target: input.target,
			documentRevision: input.documentRevision,
		},
		workbaseRoot: input.workbaseRoot,
		sourceLocations: EXECUTION_SOURCE_LOCATIONS,
		workspace: {
			state: input.dryRun ? ("planned" as const) : ("materialized" as const),
			executionDirectory,
			taskDocument: input.taskPath,
			phaseDocument: input.phasePath ?? null,
			checkoutPath: input.checkoutPath ?? null,
		},
		...(input.dryRun
			? {
					plannedActions: [
						{
							kind: "workspace-materialization" as const,
							target: input.target,
							checkoutPath: input.checkoutPath ?? null,
						},
					],
				}
			: {}),
		commands: {
			work: {
				cwd: executionDirectory,
				argv: ["agency", "work", ".", "--auto"],
			},
			context: {
				cwd: executionDirectory,
				argv: ["agency", "context", documentPath, "--json"],
			},
		},
	}
}
