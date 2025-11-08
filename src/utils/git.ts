import { resolve } from "path"
import { realpath } from "fs/promises"

/**
 * Check if a directory is inside a git repository
 */
export async function isInsideGitRepo(path: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
			cwd: path,
			stdout: "pipe",
			stderr: "pipe",
		})

		await proc.exited
		return proc.exitCode === 0
	} catch {
		return false
	}
}

/**
 * Get the git repository root directory
 */
export async function getGitRoot(path: string): Promise<string | null> {
	try {
		const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
			cwd: path,
			stdout: "pipe",
			stderr: "pipe",
		})

		await proc.exited

		if (proc.exitCode !== 0) {
			return null
		}

		const output = await new Response(proc.stdout).text()
		return output.trim()
	} catch {
		return null
	}
}

/**
 * Check if a path is the root of a git repository
 */
export async function isGitRoot(path: string): Promise<boolean> {
	const absolutePath = await realpath(resolve(path))
	const gitRoot = await getGitRoot(absolutePath)

	if (!gitRoot) {
		return false
	}

	const gitRootReal = await realpath(gitRoot)
	return gitRootReal === absolutePath
}

/**
 * Get a git config value from the repository
 */
export async function getGitConfig(
	key: string,
	gitRoot: string,
): Promise<string | null> {
	try {
		const proc = Bun.spawn(["git", "config", "--local", "--get", key], {
			cwd: gitRoot,
			stdout: "pipe",
			stderr: "pipe",
		})

		await proc.exited

		if (proc.exitCode !== 0) {
			return null
		}

		const output = await new Response(proc.stdout).text()
		return output.trim()
	} catch {
		return null
	}
}

/**
 * Set a git config value in the repository
 */
export async function setGitConfig(
	key: string,
	value: string,
	gitRoot: string,
): Promise<void> {
	const proc = Bun.spawn(["git", "config", "--local", key, value], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	await proc.exited

	if (proc.exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text()
		throw new Error(`Failed to set git config ${key}: ${stderr}`)
	}
}

/**
 * Get the configured base branch for a given feature branch
 */
export async function getBaseBranchConfig(
	featureBranch: string,
	gitRoot: string,
): Promise<string | null> {
	const key = `agency.pr.${featureBranch}.baseBranch`
	return await getGitConfig(key, gitRoot)
}

/**
 * Set the base branch configuration for a given feature branch
 */
export async function setBaseBranchConfig(
	featureBranch: string,
	baseBranch: string,
	gitRoot: string,
): Promise<void> {
	const key = `agency.pr.${featureBranch}.baseBranch`
	await setGitConfig(key, baseBranch, gitRoot)
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(gitRoot: string): Promise<string> {
	const proc = Bun.spawn(["git", "branch", "--show-current"], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	await proc.exited

	if (proc.exitCode !== 0) {
		throw new Error("Failed to get current branch")
	}

	const output = await new Response(proc.stdout).text()
	return output.trim()
}

/**
 * Check if a branch exists locally
 */
export async function branchExists(
	gitRoot: string,
	branch: string,
): Promise<boolean> {
	// Strip remote prefix if present to check local branch
	const localBranch = branch.replace(/^origin\//, "")

	const proc = Bun.spawn(
		["git", "show-ref", "--verify", "--quiet", `refs/heads/${localBranch}`],
		{
			cwd: gitRoot,
			stdout: "pipe",
			stderr: "pipe",
		},
	)

	await proc.exited
	return proc.exitCode === 0
}

/**
 * Get the default remote branch (usually origin/main or origin/master)
 */
export async function getDefaultRemoteBranch(
	gitRoot: string,
): Promise<string | null> {
	// Check what origin/HEAD points to
	const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "origin/HEAD"], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	await proc.exited

	if (proc.exitCode === 0) {
		const output = await new Response(proc.stdout).text()
		return output.trim()
	}

	return null
}

/**
 * Find the main/base branch for this repository
 * Returns the branch name without the remote prefix (e.g., "main" instead of "origin/main")
 */
export async function findMainBranch(gitRoot: string): Promise<string | null> {
	// Check what the actual default remote branch is
	const defaultRemote = await getDefaultRemoteBranch(gitRoot)
	if (defaultRemote && (await branchExists(gitRoot, defaultRemote))) {
		// Strip the remote prefix if present
		const match = defaultRemote.match(/^origin\/(.+)$/)
		if (match) {
			return match[1] || null
		}
		return defaultRemote
	}

	// Try common base branches in order
	const commonBases = ["main", "master"]
	for (const base of commonBases) {
		if (await branchExists(gitRoot, base)) {
			return base
		}
	}

	return null
}

/**
 * Get the configured main branch for this repository
 */
export async function getMainBranchConfig(
	gitRoot: string,
): Promise<string | null> {
	return await getGitConfig("agency.mainBranch", gitRoot)
}

/**
 * Set the main branch configuration for this repository
 */
export async function setMainBranchConfig(
	mainBranch: string,
	gitRoot: string,
): Promise<void> {
	await setGitConfig("agency.mainBranch", mainBranch, gitRoot)
}

/**
 * Check if the current branch is a feature branch
 * A branch is considered a feature branch if it's not the main branch
 */
export async function isFeatureBranch(
	currentBranch: string,
	gitRoot: string,
): Promise<boolean> {
	// Get or find the main branch
	let mainBranch = await getMainBranchConfig(gitRoot)
	if (!mainBranch) {
		mainBranch = await findMainBranch(gitRoot)
		// Save it for future use
		if (mainBranch) {
			await setMainBranchConfig(mainBranch, gitRoot)
		}
	}

	// If we couldn't determine a main branch, assume current is a feature branch
	if (!mainBranch) {
		return true
	}

	// Current branch is not a feature branch if it's the main branch
	return currentBranch !== mainBranch
}

/**
 * Create a new branch from the current branch
 */
export async function createBranch(
	branchName: string,
	gitRoot: string,
): Promise<void> {
	const proc = Bun.spawn(["git", "checkout", "-b", branchName], {
		cwd: gitRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	await proc.exited

	if (proc.exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text()
		throw new Error(`Failed to create branch: ${stderr}`)
	}
}
