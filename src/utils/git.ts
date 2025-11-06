import { resolve } from "path";
import { realpath } from "fs/promises";

/**
 * Check if a directory is inside a git repository
 */
export async function isInsideGitRepo(path: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
    });
    
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
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
    });
    
    await proc.exited;
    
    if (proc.exitCode !== 0) {
      return null;
    }
    
    const output = await new Response(proc.stdout).text();
    return output.trim();
  } catch {
    return null;
  }
}

/**
 * Check if a path is the root of a git repository
 */
export async function isGitRoot(path: string): Promise<boolean> {
  const absolutePath = await realpath(resolve(path));
  const gitRoot = await getGitRoot(absolutePath);
  
  if (!gitRoot) {
    return false;
  }
  
  const gitRootReal = await realpath(gitRoot);
  return gitRootReal === absolutePath;
}
