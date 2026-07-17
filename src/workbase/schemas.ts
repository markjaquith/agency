import { Schema } from "@effect/schema"

const NonEmptyString = Schema.String.pipe(Schema.minLength(1))

const Description = Schema.optional(NonEmptyString)

const IdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export const EntityId = NonEmptyString.pipe(Schema.pattern(IdPattern))

export const RepositoryAlias = NonEmptyString.pipe(Schema.pattern(IdPattern))

export const RepositoryReference = Schema.Struct({
	repo: RepositoryAlias,
	ref: NonEmptyString,
})

export const WorkStatus = Schema.Literal(
	"open",
	"working",
	"delegated",
	"done",
	"dropped",
)

const IsoTimestamp = NonEmptyString.pipe(
	Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
)

const DocumentRevision = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))

export const ClaimRecord = Schema.Struct({
	claimant: NonEmptyString,
	runner: NonEmptyString,
	sessionId: NonEmptyString,
	startedAt: IsoTimestamp,
	targetRevision: DocumentRevision,
	expiresAt: Schema.optional(IsoTimestamp),
	state: Schema.Literal("active", "released", "finished"),
	releasedAt: Schema.optional(IsoTimestamp),
	finishedAt: Schema.optional(IsoTimestamp),
	outcome: Schema.optional(Schema.Literal("done", "dropped")),
})

const Url = NonEmptyString.pipe(Schema.pattern(/^[a-zA-Z][a-zA-Z0-9+.-]*:/))

const GitHubPullRequestUrl = NonEmptyString.pipe(
	Schema.pattern(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/),
)

export const WorkbaseConfig = Schema.Struct({
	version: Schema.Literal(2),
	chooserCommand: Schema.optional(Schema.NonEmptyArray(NonEmptyString)),
	worktreeCreateCommand: Schema.optional(Schema.NonEmptyArray(NonEmptyString)),
})

export const LegacyWorkbaseRegistry = Schema.Struct({
	version: Schema.Literal(1),
	workbases: Schema.Array(NonEmptyString),
})

export const WorkbaseRegistration = Schema.Struct({
	id: EntityId,
	name: Schema.optional(EntityId),
	path: NonEmptyString,
})

export const WorkbaseRegistry = Schema.Struct({
	version: Schema.Literal(2),
	workbases: Schema.Array(WorkbaseRegistration),
	defaultId: Schema.optional(EntityId),
})

export const Dependency = Schema.Struct({
	id: EntityId,
	dependsOn: Schema.optional(Schema.Array(EntityId)),
})

const ExecutionUnit = {
	repo: RepositoryAlias,
	repos: Schema.optional(Schema.Array(RepositoryReference)),
	branch: NonEmptyString,
	base: NonEmptyString,
	pr: Schema.NullOr(GitHubPullRequestUrl),
	status: Schema.optionalWith(WorkStatus, { default: () => "open" as const }),
	claim: Schema.optional(ClaimRecord),
}

export const EpicFrontmatter = Schema.Struct({
	ticketUrl: Url,
	description: Description,
	repos: Schema.NonEmptyArray(RepositoryReference),
	tasks: Schema.Array(Dependency),
})

const SinglePhaseTaskFrontmatter = Schema.Struct({
	ticketUrl: Schema.NullOr(Url),
	description: Description,
	epic: Schema.optional(EntityId),
	...ExecutionUnit,
})

const MultiPhaseTaskFrontmatter = Schema.Struct({
	ticketUrl: Schema.NullOr(Url),
	description: Description,
	epic: Schema.optional(EntityId),
	phases: Schema.Array(Dependency),
})

export const TaskFrontmatter = Schema.Union(
	SinglePhaseTaskFrontmatter,
	MultiPhaseTaskFrontmatter,
)

export const PhaseFrontmatter = Schema.Struct({
	description: Description,
	...ExecutionUnit,
})

export type WorkbaseConfig = Schema.Schema.Type<typeof WorkbaseConfig>
export type WorkbaseRegistry = Schema.Schema.Type<typeof WorkbaseRegistry>
export type WorkbaseRegistration = Schema.Schema.Type<
	typeof WorkbaseRegistration
>
export type Dependency = Schema.Schema.Type<typeof Dependency>
export type RepositoryReference = Schema.Schema.Type<typeof RepositoryReference>
export type WorkStatus = Schema.Schema.Type<typeof WorkStatus>
export type ClaimRecord = Schema.Schema.Type<typeof ClaimRecord>
export type EpicFrontmatter = Schema.Schema.Type<typeof EpicFrontmatter>
export type TaskFrontmatter = Schema.Schema.Type<typeof TaskFrontmatter>
export type PhaseFrontmatter = Schema.Schema.Type<typeof PhaseFrontmatter>
