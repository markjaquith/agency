import { mkdtemp, rm, cp } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

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

		const proc = Bun.spawn(["git", "init", "-b", "main"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		})
		await proc.exited

		if (proc.exitCode !== 0) {
			throw new Error("Failed to initialize template git repository")
		}

		// Write config directly
		const configFile = Bun.file(join(tempDir, ".git", "config"))
		const existingConfig = await configFile.text()
		const newConfig =
			existingConfig +
			"\n[user]\n\temail = test@example.com\n\tname = Test User\n[core]\n\thooksPath = /dev/null\n"
		await Bun.write(join(tempDir, ".git", "config"), newConfig)

		// Create initial commit
		await Bun.write(join(tempDir, ".gitkeep"), "")
		await Bun.spawn(["git", "add", ".gitkeep"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "-m", "Initial commit"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

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
	} catch (error) {
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
	const output = await getGitOutput(cwd, ["branch", "--show-current"])
	return output.trim()
}

/**
 * Run a git command directly - fire and forget version (fastest)
 */
async function gitRun(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await proc.exited
}

/**
 * Create a test commit in a git repository
 */
export async function createCommit(
	cwd: string,
	message: string,
): Promise<void> {
	// Create a test file and commit it
	await Bun.write(join(cwd, "test.txt"), message)
	await gitRun(cwd, ["add", "test.txt"])
	await gitRun(cwd, ["commit", "--no-verify", "-m", message])
}

/**
 * Checkout a branch in a git repository
 */
export async function checkoutBranch(
	cwd: string,
	branchName: string,
): Promise<void> {
	await gitRun(cwd, [
		"-c",
		"advice.detachedHead=false",
		"checkout",
		"-q",
		branchName,
	])
}

/**
 * Create a new branch and switch to it
 */
export async function createBranch(
	cwd: string,
	branchName: string,
): Promise<void> {
	await gitRun(cwd, ["checkout", "-q", "-b", branchName])
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
	await gitRun(cwd, ["add", ...fileList])
	await gitRun(cwd, ["commit", "--no-verify", "-m", message])
}

/**
 * Setup a remote and fetch in a single operation
 */
export async function setupRemote(
	cwd: string,
	remoteName: string,
	remoteUrl: string,
): Promise<void> {
	await gitRun(cwd, ["remote", "add", remoteName, remoteUrl])
	await gitRun(cwd, ["fetch", remoteName])
}

/**
 * Delete a branch
 */
export async function deleteBranch(
	cwd: string,
	branchName: string,
	force: boolean = false,
): Promise<void> {
	const flag = force ? "-D" : "-d"
	await gitRun(cwd, ["branch", flag, branchName])
}

/**
 * Reset a git repo to clean state for test reuse.
 * This is much faster than creating a new repo from scratch.
 * - Checks out main branch
 * - Removes all other branches
 * - Resets to initial commit
 * - Cleans untracked files
 * - Removes agency git config
 */
export async function resetGitRepo(cwd: string): Promise<void> {
	// Checkout main
	await gitRun(cwd, ["checkout", "-q", "main"])

	// Delete all branches except main
	const branchOutput = await getGitOutput(cwd, ["branch", "--list"])
	const branches = branchOutput
		.split("\n")
		.map((b) => b.replace(/^\*?\s*/, "").trim())
		.filter((b) => b && b !== "main")

	for (const branch of branches) {
		await gitRun(cwd, ["branch", "-D", branch])
	}

	// Reset to first commit (the initial commit from template)
	const firstCommit = (
		await getGitOutput(cwd, ["rev-list", "--max-parents=0", "HEAD"])
	).trim()
	await gitRun(cwd, ["reset", "--hard", firstCommit])

	// Clean untracked files and directories
	await gitRun(cwd, ["clean", "-fdx"])

	// Remove agency config
	try {
		await gitRun(cwd, ["config", "--unset", "agency.template"])
	} catch {
		// Ignore if not set
	}
}

/**
 * Rename current branch
 */
export async function renameBranch(
	cwd: string,
	newName: string,
): Promise<void> {
	await gitRun(cwd, ["branch", "-m", newName])
}

/**
 * Check if a branch exists in a git repository
 */
export async function branchExists(
	cwd: string,
	branch: string,
): Promise<boolean> {
	const proc = Bun.spawn(["git", "rev-parse", "--verify", branch], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	await proc.exited
	return proc.exitCode === 0
}

/**
 * Initialize a repository with agency by setting a template in git config
 */
export async function initAgency(
	cwd: string,
	templateName: string,
): Promise<void> {
	await Bun.spawn(
		["git", "config", "--local", "agency.template", templateName],
		{
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		},
	).exited
}

/**
 * Get a git config value for testing
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
		await proc.exited // Must await before reading stdout to prevent hangs in concurrent tests
		const output = await new Response(proc.stdout).text()
		return output.trim() || null
	} catch {
		return null
	}
}

/**
 * Run a git command
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
import { GitService } from "./services/GitService"
import { ConfigService } from "./services/ConfigService"
import { FileSystemService } from "./services/FileSystemService"
import { PromptService } from "./services/PromptService"
import { TemplateService } from "./services/TemplateService"
import { OpencodeService } from "./services/OpencodeService"
import { ClaudeService } from "./services/ClaudeService"
import { FilterRepoService } from "./services/FilterRepoService"
import { MockFilterRepoService } from "./services/MockFilterRepoService"

// Re-export mock utilities for tests
export {
	clearCapturedFilterRepoCalls,
	getCapturedFilterRepoCalls,
	getLastCapturedFilterRepoCall,
} from "./services/MockFilterRepoService"
export type { CapturedFilterRepoCall } from "./services/MockFilterRepoService"

// Create test layer with all services (real filter-repo)
const TestLayer = Layer.mergeAll(
	GitService.Default,
	ConfigService.Default,
	FileSystemService.Default,
	PromptService.Default,
	TemplateService.Default,
	OpencodeService.Default,
	ClaudeService.Default,
	FilterRepoService.Default,
)

// Create test layer with mock filter-repo (for tests that don't need real filtering)
const TestLayerWithMockFilterRepo = Layer.mergeAll(
	GitService.Default,
	ConfigService.Default,
	FileSystemService.Default,
	PromptService.Default,
	TemplateService.Default,
	OpencodeService.Default,
	ClaudeService.Default,
	MockFilterRepoService.Default,
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

/**
 * Run a test effect with MockFilterRepoService instead of the real one.
 * Use this for tests that need to verify filter-repo command construction
 * without actually running git-filter-repo.
 */
export async function runTestEffectWithMockFilterRepo<A, E>(
	effect: Effect.Effect<A, E, any>,
): Promise<A> {
	const providedEffect = Effect.provide(
		effect,
		TestLayerWithMockFilterRepo,
	) as Effect.Effect<A, E, never>
	const program = Effect.catchAllDefect(providedEffect, (defect) =>
		Effect.fail(defect instanceof Error ? defect : new Error(String(defect))),
	) as Effect.Effect<A, E | Error, never>

	return await Effect.runPromise(program)
}
