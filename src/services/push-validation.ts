export interface PushCommitMetadata {
	readonly commitId: string
	readonly description: string
	readonly authorName: string
	readonly authorEmail: string
}

export const parseGitCommits = (
	output: string,
): readonly PushCommitMetadata[] =>
	output
		.split("\x1e")
		.map((record) => record.replace(/^\n+|\n+$/g, ""))
		.filter(Boolean)
		.map((record) => {
			const [
				commitId = "",
				authorName = "",
				authorEmail = "",
				description = "",
			] = record.split("\0")
			return {
				commitId,
				description,
				authorName,
				authorEmail,
			}
		})
