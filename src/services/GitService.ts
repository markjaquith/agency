import { Effect, Context, Data } from "effect"

// Error types for Git operations
export class GitError extends Data.TaggedError("GitError")<{
	message: string
	cause?: unknown
}> {}

export class NotInGitRepoError extends Data.TaggedError("NotInGitRepoError")<{
	path: string
}> {}

export class BranchNotFoundError extends Data.TaggedError(
	"BranchNotFoundError",
)<{
	branch: string
}> {}

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
	command: string
	exitCode: number
	stderr: string
}> {}

// Git Service interface using latest Effect.Service pattern
export class GitService extends Context.Tag("GitService")<
	GitService,
	{
		readonly isInsideGitRepo: (path: string) => Effect.Effect<boolean, GitError>
		readonly getGitRoot: (
			path: string,
		) => Effect.Effect<string, NotInGitRepoError>
		readonly isGitRoot: (path: string) => Effect.Effect<boolean, GitError>
		readonly getGitConfig: (
			key: string,
			gitRoot: string,
		) => Effect.Effect<string | null, GitError>
		readonly setGitConfig: (
			key: string,
			value: string,
			gitRoot: string,
		) => Effect.Effect<void, GitError>
		readonly getCurrentBranch: (
			gitRoot: string,
		) => Effect.Effect<string, GitCommandError>
		readonly branchExists: (
			gitRoot: string,
			branch: string,
		) => Effect.Effect<boolean, GitError>
		readonly createBranch: (
			branchName: string,
			gitRoot: string,
			baseBranch?: string,
		) => Effect.Effect<void, GitCommandError>
		readonly checkoutBranch: (
			gitRoot: string,
			branch: string,
		) => Effect.Effect<void, GitCommandError>
		readonly gitAdd: (
			files: readonly string[],
			gitRoot: string,
		) => Effect.Effect<void, GitCommandError>
		readonly gitCommit: (
			message: string,
			gitRoot: string,
			options?: { readonly noVerify?: boolean },
		) => Effect.Effect<void, GitCommandError>
		readonly getDefaultRemoteBranch: (
			gitRoot: string,
		) => Effect.Effect<string | null, GitError>
		readonly findMainBranch: (
			gitRoot: string,
		) => Effect.Effect<string | null, GitError>
		readonly getSuggestedBaseBranches: (
			gitRoot: string,
		) => Effect.Effect<readonly string[], GitError>
		readonly isFeatureBranch: (
			currentBranch: string,
			gitRoot: string,
		) => Effect.Effect<boolean, GitError>
		readonly getMainBranchConfig: (
			gitRoot: string,
		) => Effect.Effect<string | null, GitError>
		readonly setMainBranchConfig: (
			mainBranch: string,
			gitRoot: string,
		) => Effect.Effect<void, GitError>
		readonly getDefaultBaseBranchConfig: (
			gitRoot: string,
		) => Effect.Effect<string | null, GitError>
		readonly setDefaultBaseBranchConfig: (
			baseBranch: string,
			gitRoot: string,
		) => Effect.Effect<void, GitError>
	}
>() {}
