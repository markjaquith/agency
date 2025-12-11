import { mkdtemp, rm, cp } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import * as git from "isomorphic-git"
import * as fs from "node:fs"

// Default author for commits
const DEFAULT_AUTHOR = {
	name: "Test User",
	email: "test@example.com",
}

// Cache a template git repository to speed up test setup
let templateGitRepo: string | null = null
let templateGitRepoPromise: Promise<string> | null = null

async function getTemplateGitRepo(): Promise<string> {
	// Return cached result if available
	if (templateGitRepo) {
		return templateGitRepo
	}

	// Use a promise to prevent concurrent initialization (race condition fix)
	if (templateGitRepoPromise) {
		return templateGitRepoPromise
	}

	// Create and cache the initialization promise
	templateGitRepoPromise = (async () => {
		// Create a template git repo once and reuse it
		const tempDir = await mkdtemp(join(tmpdir(), "agency-template-"))

		// Initialize with isomorphic-git
		await git.init({ fs, dir: tempDir, defaultBranch: "main" })

		// Set user config
		await git.setConfig({
			fs,
			dir: tempDir,
			path: "user.email",
			value: "test@example.com",
		})
		await git.setConfig({
			fs,
			dir: tempDir,
			path: "user.name",
			value: "Test User",
		})

		// Create initial commit
		await Bun.write(join(tempDir, ".gitkeep"), "")
		await git.add({ fs, dir: tempDir, filepath: ".gitkeep" })
		await git.commit({
			fs,
			dir: tempDir,
			message: "Initial commit",
			author: DEFAULT_AUTHOR,
		})

		templateGitRepo = tempDir
		return tempDir
	})()

	return templateGitRepoPromise
}

/**
 * Create a temporary directory for testing
 */
export async function createTempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "agency-test-"))
}

/**
 * Clean up a temporary directory
 */
export async function cleanupTempDir(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true })
	} catch (_error) {
		// Ignore errors during cleanup
	}
}

/**
 * Initialize a git repository in a directory
 * Uses a cached template repository for much faster setup
 */
export async function initGitRepo(path: string): Promise<void> {
	const template = await getTemplateGitRepo()

	// Copy the template .git directory
	await cp(join(template, ".git"), join(path, ".git"), {
		recursive: true,
	})

	// Copy the .gitkeep file
	await cp(join(template, ".gitkeep"), join(path, ".gitkeep"))
}

/**
 * Create a subdirectory in a path
 */
export async function createSubdir(
	basePath: string,
	name: string,
): Promise<string> {
	const subdirPath = join(basePath, name)
	await Bun.write(join(subdirPath, ".gitkeep"), "")
	return subdirPath
}

/**
 * Check if a file exists
 */
export async function fileExists(path: string): Promise<boolean> {
	const file = Bun.file(path)
	return await file.exists()
}

/**
 * Read file content
 */
export async function readFile(path: string): Promise<string> {
	const file = Bun.file(path)
	return await file.text()
}

/**
 * Execute a git command and return its output
 * Note: Some operations still need to spawn git (e.g., for complex queries)
 */
export async function getGitOutput(
	cwd: string,
	args: string[],
): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await proc.exited
	return await new Response(proc.stdout).text()
}

/**
 * Get the current branch name in a git repository
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
	const branch = await git.currentBranch({ fs, dir: cwd, fullname: false })
	return branch || ""
}

/**
 * Create a test commit in a git repository
 */
export async function createCommit(
	cwd: string,
	message: string,
): Promise<void> {
	// Create a test file and commit it
	// Use "test.txt" for compatibility with existing tests
	await Bun.write(join(cwd, "test.txt"), message)
	await git.add({ fs, dir: cwd, filepath: "test.txt" })
	await git.commit({
		fs,
		dir: cwd,
		message,
		author: DEFAULT_AUTHOR,
	})
}

/**
 * Checkout a branch in a git repository
 */
export async function checkoutBranch(
	cwd: string,
	branchName: string,
): Promise<void> {
	await git.checkout({ fs, dir: cwd, ref: branchName })
}

/**
 * Create a new branch and switch to it
 */
export async function createBranch(
	cwd: string,
	branchName: string,
): Promise<void> {
	await git.branch({ fs, dir: cwd, ref: branchName, checkout: true })
}

/**
 * Stage files and commit in a single operation
 */
export async function addAndCommit(
	cwd: string,
	files: string | string[],
	message: string,
): Promise<void> {
	const fileList = Array.isArray(files) ? files : files.split(" ")
	for (const file of fileList) {
		await git.add({ fs, dir: cwd, filepath: file })
	}
	await git.commit({
		fs,
		dir: cwd,
		message,
		author: DEFAULT_AUTHOR,
	})
}

/**
 * Setup a remote and fetch in a single operation
 */
export async function setupRemote(
	cwd: string,
	remoteName: string,
	remoteUrl: string,
): Promise<void> {
	await git.addRemote({ fs, dir: cwd, remote: remoteName, url: remoteUrl })
	// Note: fetch requires http transport, skip in tests
}

/**
 * Delete a branch
 */
export async function deleteBranch(
	cwd: string,
	branchName: string,
	_force: boolean = false,
): Promise<void> {
	await git.deleteBranch({ fs, dir: cwd, ref: branchName })
}

/**
 * Rename current branch
 */
export async function renameBranch(
	cwd: string,
	newName: string,
): Promise<void> {
	const currentBranch = await git.currentBranch({ fs, dir: cwd })
	if (!currentBranch) throw new Error("Not on a branch")

	// Get current commit
	const oid = await git.resolveRef({ fs, dir: cwd, ref: "HEAD" })

	// Create new branch at current commit
	await git.branch({ fs, dir: cwd, ref: newName, object: oid })

	// Checkout new branch
	await git.checkout({ fs, dir: cwd, ref: newName })

	// Delete old branch
	await git.deleteBranch({ fs, dir: cwd, ref: currentBranch })
}

/**
 * Check if a branch exists in a git repository
 */
export async function branchExists(
	cwd: string,
	branch: string,
): Promise<boolean> {
	const branches = await git.listBranches({ fs, dir: cwd })
	return branches.includes(branch)
}

/**
 * Initialize a repository with agency by setting a template in git config
 */
export async function initAgency(
	cwd: string,
	templateName: string,
): Promise<void> {
	await git.setConfig({
		fs,
		dir: cwd,
		path: "agency.template",
		value: templateName,
	})
}

/**
 * Get a git config value for testing
 */
export async function getGitConfig(
	key: string,
	gitRoot: string,
): Promise<string | null> {
	try {
		const value = await git.getConfig({ fs, dir: gitRoot, path: key })
		return value !== undefined ? String(value) : null
	} catch {
		return null
	}
}

/**
 * Run a git command (fallback for complex operations)
 */
export async function runGitCommand(
	cwd: string,
	args: string[],
): Promise<void> {
	const proc = Bun.spawn(args, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await proc.exited
	if (proc.exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text()
		throw new Error(`Git command failed: ${args.join(" ")}\n${stderr}`)
	}
}

/**
 * Create a file with content
 */
export async function createFile(
	cwd: string,
	filename: string,
	content: string,
): Promise<void> {
	await Bun.write(join(cwd, filename), content)
}

/**
 * Run an Effect in tests with all services provided
 */
import { Effect, Layer } from "effect"
import { IsomorphicGitService } from "./services/IsomorphicGitService"
import { ConfigService } from "./services/ConfigService"
import { FileSystemService } from "./services/FileSystemService"
import { PromptService } from "./services/PromptService"
import { TemplateService } from "./services/TemplateService"
import { OpencodeService } from "./services/OpencodeService"

// Create test layer with all services
// Use IsomorphicGitService instead of GitService for faster tests (no process spawning)
const TestLayer = Layer.mergeAll(
	IsomorphicGitService.Default,
	ConfigService.Default,
	FileSystemService.Default,
	PromptService.Default,
	TemplateService.Default,
	OpencodeService.Default,
)

export async function runTestEffect<A, E>(
	effect: Effect.Effect<A, E, any>,
): Promise<A> {
	const providedEffect = Effect.provide(effect, TestLayer) as Effect.Effect<
		A,
		E,
		never
	>
	const program = Effect.catchAllDefect(providedEffect, (defect) =>
		Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
	) as Effect.Effect<A, E | Error, never>

	return await Effect.runPromise(program)
}
