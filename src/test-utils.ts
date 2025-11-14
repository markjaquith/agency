import { mkdtemp, rm, cp } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

// Cache a template git repository to speed up test setup
let templateGitRepo: string | null = null

async function getTemplateGitRepo(): Promise<string> {
	if (templateGitRepo) {
		return templateGitRepo
	}

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
