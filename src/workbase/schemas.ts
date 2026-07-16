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

export const WorkStatus = Schema.Literal("open", "working", "done", "dropped")

const Url = NonEmptyString.pipe(Schema.pattern(/^[a-zA-Z][a-zA-Z0-9+.-]*:/))

const GitHubPullRequestUrl = NonEmptyString.pipe(
	Schema.pattern(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/),
)

export const WorkbaseConfig = Schema.Struct({
	version: Schema.Literal(2),
	worktreeCreateCommand: Schema.optional(Schema.NonEmptyArray(NonEmptyString)),
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
}

export const EpicFrontmatter = Schema.Struct({
	ticketUrl: Url,
	description: Description,
	repos: Schema.NonEmptyArray(RepositoryReference),
	tasks: Schema.Array(Dependency),
})

const SinglePhaseTaskFrontmatter = Schema.Struct({
	ticketUrl: Url,
	description: Description,
	epic: Schema.optional(EntityId),
	...ExecutionUnit,
})

const MultiPhaseTaskFrontmatter = Schema.Struct({
	ticketUrl: Url,
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
export type Dependency = Schema.Schema.Type<typeof Dependency>
export type RepositoryReference = Schema.Schema.Type<typeof RepositoryReference>
export type WorkStatus = Schema.Schema.Type<typeof WorkStatus>
export type EpicFrontmatter = Schema.Schema.Type<typeof EpicFrontmatter>
export type TaskFrontmatter = Schema.Schema.Type<typeof TaskFrontmatter>
export type PhaseFrontmatter = Schema.Schema.Type<typeof PhaseFrontmatter>
