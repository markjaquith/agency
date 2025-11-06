import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Create a temporary directory for testing
 */
export async function createTempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agency-test-"));
}

/**
 * Clean up a temporary directory
 */
export async function cleanupTempDir(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    // Ignore errors during cleanup
  }
}

/**
 * Initialize a git repository in a directory
 */
export async function initGitRepo(path: string): Promise<void> {
  const proc = Bun.spawn(["git", "init"], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
  });
  
  await proc.exited;
  
  if (proc.exitCode !== 0) {
    throw new Error("Failed to initialize git repository");
  }
  
  // Configure git user for the test repo
  await Bun.spawn(["git", "config", "user.email", "test@example.com"], {
    cwd: path,
  }).exited;
  
  await Bun.spawn(["git", "config", "user.name", "Test User"], {
    cwd: path,
  }).exited;
  
  // Disable all git hooks for this repo
  await Bun.spawn(["git", "config", "core.hooksPath", "/dev/null"], {
    cwd: path,
  }).exited;
}

/**
 * Create a subdirectory in a path
 */
export async function createSubdir(basePath: string, name: string): Promise<string> {
  const subdirPath = join(basePath, name);
  await Bun.write(join(subdirPath, ".gitkeep"), "");
  return subdirPath;
}

/**
 * Check if a file exists
 */
export async function fileExists(path: string): Promise<boolean> {
  const file = Bun.file(path);
  return await file.exists();
}

/**
 * Read file content
 */
export async function readFile(path: string): Promise<string> {
  const file = Bun.file(path);
  return await file.text();
}
