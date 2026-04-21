import { isAbsolute, resolve } from "path"

export const resolveGitInternalPath = (
	gitRoot: string,
	gitPath: string,
): string => (isAbsolute(gitPath) ? gitPath : resolve(gitRoot, gitPath))
