import { Schema } from "@effect/schema"

const NonEmptyString = Schema.String.pipe(Schema.minLength(1))
const EnvironmentName = NonEmptyString.pipe(
	Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
)

const Description = Schema.optional(NonEmptyString)

const IdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export const EntityId = NonEmptyString.pipe(Schema.pattern(IdPattern))

export const RepositoryAlias = NonEmptyString.pipe(Schema.pattern(IdPattern))

// Portable declarations must be usable after cloning the workbase elsewhere.
// Local paths, file URLs, and credential-bearing HTTP URLs are intentionally
// excluded; SSH usernames are identities and remain supported.
export const RepositoryRemote = NonEmptyString.pipe(
	Schema.pattern(
		/^(?!-)(?![a-zA-Z]:[\\/])(?!https?:\/\/[^/@\s]+@)(?![a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@)(?:(?:https?|ssh|git):\/\/[^\s?#]+|(?![^\s]*::)(?:[^@\s/:]+@)?[a-zA-Z0-9_.][^@\s/:]*:(?!\/\/)[^\s?#]+)$/,
	),
)

export const RepositoryDeclaration = Schema.Struct({
	remote: RepositoryRemote,
})

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

const GitCommit = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/))

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

export const PullRequestRecord = Schema.Struct({
	provider: EntityId,
	repository: NonEmptyString,
	identifier: NonEmptyString,
	url: Url,
	state: Schema.Literal("open", "closed", "merged"),
	draft: Schema.Boolean,
	merged: Schema.Boolean,
	mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
})

export const CompletionRecord = Schema.Struct({
	mode: Schema.Literal("non-pr"),
	completedAt: IsoTimestamp,
	summary: NonEmptyString,
	evidenceUrl: Schema.optional(Url),
})

const DeliveryProvider = Schema.Struct({
	provider: EntityId,
	remote: Schema.optional(NonEmptyString),
	createCommand: Schema.NonEmptyArray(NonEmptyString),
	queryCommand: Schema.NonEmptyArray(NonEmptyString),
	environment: Schema.optional(
		Schema.Record({ key: EnvironmentName, value: Schema.String }),
	),
})

export const WorkbaseConfig = Schema.Struct({
	version: Schema.Literal(2),
	repositories: Schema.optional(
		Schema.Record({ key: RepositoryAlias, value: RepositoryDeclaration }),
	),
	chooserCommand: Schema.optional(Schema.NonEmptyArray(NonEmptyString)),
	worktreeCreateCommand: Schema.optional(Schema.NonEmptyArray(NonEmptyString)),
	runners: Schema.optional(
		Schema.Record({
			key: EntityId,
			value: Schema.Struct({
				command: Schema.NonEmptyArray(NonEmptyString),
				autoCommand: Schema.optional(Schema.NonEmptyArray(NonEmptyString)),
				resumeCommand: Schema.optional(Schema.NonEmptyArray(NonEmptyString)),
				autoResumeCommand: Schema.optional(
					Schema.NonEmptyArray(NonEmptyString),
				),
				environment: Schema.optional(
					Schema.Record({ key: EnvironmentName, value: Schema.String }),
				),
			}),
		}),
	),
	delivery: Schema.optional(DeliveryProvider),
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
	pr: Schema.NullOr(Schema.Union(GitHubPullRequestUrl, PullRequestRecord)),
	status: Schema.optionalWith(WorkStatus, { default: () => "open" as const }),
	claim: Schema.optional(ClaimRecord),
	completion: Schema.optional(CompletionRecord),
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

export const ReviewPullRequestSource = Schema.Struct({
	kind: Schema.Literal("pull-request"),
	provider: Schema.Literal("github"),
	repository: NonEmptyString,
	identifier: NonEmptyString.pipe(Schema.pattern(/^\d+$/)),
	url: GitHubPullRequestUrl,
	fetchRef: NonEmptyString,
}).pipe(
	Schema.filter(
		(source) =>
			source.url ===
				`https://github.com/${source.repository}/pull/${source.identifier}` &&
			source.fetchRef === `refs/pull/${source.identifier}/head`,
		{
			message: () =>
				"Pull request review source URL, repository, identifier, and fetch ref must agree",
		},
	),
)

export const ReviewBranchSource = Schema.Struct({
	kind: Schema.Literal("branch"),
	ref: NonEmptyString.pipe(
		Schema.pattern(
			/^refs\/heads\/(?!HEAD$)(?!.*(?:\.\.|@\{|[ ~^:?*\[\\\]]))(?!.*\/\/)(?!.*(?:^|\/)\.)(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9._\/-]+$/,
		),
	),
})

export const ReviewSource = Schema.Union(
	ReviewPullRequestSource,
	ReviewBranchSource,
)

export const ReviewRecord = Schema.Struct({
	repo: RepositoryAlias,
	source: ReviewSource,
	commit: GitCommit,
	refreshedAt: IsoTimestamp,
})

const ReviewTaskFrontmatter = Schema.Struct({
	ticketUrl: Schema.NullOr(Url),
	description: Description,
	epic: Schema.optional(EntityId),
	review: ReviewRecord,
	status: Schema.optionalWith(WorkStatus, { default: () => "open" as const }),
	claim: Schema.optional(ClaimRecord),
	completion: Schema.optional(CompletionRecord),
})

export const TaskFrontmatter = Schema.Union(
	SinglePhaseTaskFrontmatter,
	MultiPhaseTaskFrontmatter,
	ReviewTaskFrontmatter,
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
export type RepositoryDeclaration = Schema.Schema.Type<
	typeof RepositoryDeclaration
>
export type WorkStatus = Schema.Schema.Type<typeof WorkStatus>
export type ClaimRecord = Schema.Schema.Type<typeof ClaimRecord>
export type PullRequestRecord = Schema.Schema.Type<typeof PullRequestRecord>
export type ReviewSource = Schema.Schema.Type<typeof ReviewSource>
export type ReviewRecord = Schema.Schema.Type<typeof ReviewRecord>
export type CompletionRecord = Schema.Schema.Type<typeof CompletionRecord>
export type EpicFrontmatter = Schema.Schema.Type<typeof EpicFrontmatter>
export type TaskFrontmatter = Schema.Schema.Type<typeof TaskFrontmatter>
export type PhaseFrontmatter = Schema.Schema.Type<typeof PhaseFrontmatter>
