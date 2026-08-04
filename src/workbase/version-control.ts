export type VersionControlKind = "git" | "jj"

export const preferredVersionControl = (
	which: (executable: string) => string | null = Bun.which,
): VersionControlKind => (which("jj") ? "jj" : "git")
