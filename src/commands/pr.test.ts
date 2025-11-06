import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { pr } from "../commands/pr";
import { init } from "../commands/init";
import { createTempDir, cleanupTempDir, initGitRepo, fileExists } from "../test-utils";

async function getGitOutput(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return await new Response(proc.stdout).text();
}

async function getCurrentBranch(cwd: string): Promise<string> {
  const output = await getGitOutput(cwd, ["branch", "--show-current"]);
  return output.trim();
}

async function createCommit(cwd: string, message: string): Promise<void> {
  // Create a test file and commit it
  await Bun.write(join(cwd, "test.txt"), message);
  await Bun.spawn(["git", "add", "test.txt"], { cwd }).exited;
  await Bun.spawn(["git", "commit", "--no-verify", "-m", message], { cwd }).exited;
}

async function isGitFilterRepoAvailable(): Promise<boolean> {
  const proc = Bun.spawn(["which", "git-filter-repo"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode === 0;
}

describe("pr command", () => {
  let tempDir: string;
  let originalCwd: string;
  let hasGitFilterRepo: boolean;
  
  beforeEach(async () => {
    tempDir = await createTempDir();
    originalCwd = process.cwd();
    process.chdir(tempDir);
    
    // Check if git-filter-repo is available
    hasGitFilterRepo = await isGitFilterRepoAvailable();
    
    // Initialize git repo with main branch
    await initGitRepo(tempDir);
    
    // Create initial commit on main
    await createCommit(tempDir, "Initial commit");
    
    // Rename master to main if needed
    const currentBranch = await getCurrentBranch(tempDir);
    if (currentBranch === "master") {
      await Bun.spawn(["git", "branch", "-m", "main"], { cwd: tempDir }).exited;
    }
    
    // Initialize AGENTS.md and CLAUDE.md
    await init({ silent: true });
    await Bun.spawn(["git", "add", "AGENTS.md", "CLAUDE.md"], { cwd: tempDir }).exited;
    await Bun.spawn(["git", "commit", "--no-verify", "-m", "Add AGENTS.md and CLAUDE.md"], { cwd: tempDir }).exited;
    
    // Set up origin/main for git-filter-repo
    await Bun.spawn(["git", "remote", "add", "origin", tempDir], { cwd: tempDir }).exited;
    await Bun.spawn(["git", "fetch", "origin"], { cwd: tempDir }).exited;
  });
  
  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  });
  
  describe("basic functionality", () => {
    test("throws error when git-filter-repo is not installed", async () => {
      if (hasGitFilterRepo) {
        // Skip this test if git-filter-repo IS installed
        return;
      }
      
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      expect(pr({ silent: true })).rejects.toThrow("git-filter-repo not installed");
    });
    
    test("creates PR branch with default name", async () => {
      if (!hasGitFilterRepo) {
        console.log("Skipping test: git-filter-repo not installed");
        return;
      }
      
      // Create a feature branch
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      // Create PR branch
      await pr({ silent: true });
      
      // Check that PR branch exists
      const branches = await getGitOutput(tempDir, ["branch", "--list", "feature--PR"]);
      expect(branches.trim()).toContain("feature--PR");
      
      // Check we're on the PR branch
      const currentBranch = await getCurrentBranch(tempDir);
      expect(currentBranch).toBe("feature--PR");
    });
    
    test("creates PR branch with custom name", async () => {
      if (!hasGitFilterRepo) {
        console.log("Skipping test: git-filter-repo not installed");
        return;
      }
      
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      await pr({ branch: "custom-pr", silent: true });
      
      const branches = await getGitOutput(tempDir, ["branch", "--list", "custom-pr"]);
      expect(branches.trim()).toContain("custom-pr");
      
      const currentBranch = await getCurrentBranch(tempDir);
      expect(currentBranch).toBe("custom-pr");
    });
    
    test("runs git-filter-repo successfully", async () => {
      if (!hasGitFilterRepo) {
        console.log("Skipping test: git-filter-repo not installed");
        return;
      }
      
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      // Should complete without throwing
      await pr({ silent: true });
      
      // Should be on PR branch
      const currentBranch = await getCurrentBranch(tempDir);
      expect(currentBranch).toBe("feature--PR");
    });
    
    test("preserves other files in PR branch", async () => {
      if (!hasGitFilterRepo) {
        console.log("Skipping test: git-filter-repo not installed");
        return;
      }
      
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      await pr({ silent: true });
      
      // Check that test file still exists
      expect(await fileExists(join(tempDir, "test.txt"))).toBe(true);
      
      const files = await getGitOutput(tempDir, ["ls-files"]);
      expect(files).toContain("test.txt");
    });
    
    test("original branch remains untouched", async () => {
      if (!hasGitFilterRepo) {
        console.log("Skipping test: git-filter-repo not installed");
        return;
      }
      
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      // Create PR branch
      await pr({ silent: true });
      
      // Switch back to feature branch
      await Bun.spawn(["git", "checkout", "feature"], { cwd: tempDir }).exited;
      
      // Check that AGENTS.md and CLAUDE.md still exist on original branch
      const files = await getGitOutput(tempDir, ["ls-files"]);
      expect(files).toContain("AGENTS.md");
      expect(files).toContain("CLAUDE.md");
    });
  });
  
  describe("error handling", () => {
    test("throws error when not in a git repository", async () => {
      const nonGitDir = await createTempDir();
      process.chdir(nonGitDir);
      
      expect(pr({ silent: true })).rejects.toThrow("Not in a git repository");
      
      await cleanupTempDir(nonGitDir);
    });
  });
  
  describe("silent mode", () => {
    test("silent flag suppresses output", async () => {
      if (!hasGitFilterRepo) {
        console.log("Skipping test: git-filter-repo not installed");
        return;
      }
      
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => logs.push(args.join(" "));
      
      await pr({ silent: true });
      
      console.log = originalLog;
      
      expect(logs.length).toBe(0);
    });
  });
});
