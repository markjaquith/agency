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
  await Bun.spawn(["git", "commit", "-m", message], { cwd }).exited;
}

describe("pr command", () => {
  let tempDir: string;
  let originalCwd: string;
  
  beforeEach(async () => {
    tempDir = await createTempDir();
    originalCwd = process.cwd();
    process.chdir(tempDir);
    
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
    await Bun.spawn(["git", "commit", "-m", "Add AGENTS.md and CLAUDE.md"], { cwd: tempDir }).exited;
  });
  
  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  });
  
  describe("basic functionality", () => {
    test("creates PR branch with default name", async () => {
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
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      await pr({ branch: "custom-pr", silent: true });
      
      const branches = await getGitOutput(tempDir, ["branch", "--list", "custom-pr"]);
      expect(branches.trim()).toContain("custom-pr");
      
      const currentBranch = await getCurrentBranch(tempDir);
      expect(currentBranch).toBe("custom-pr");
    });
    
    test("removes AGENTS.md and CLAUDE.md from PR branch", async () => {
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      await pr({ silent: true });
      
      // Check that files are not in git index
      const files = await getGitOutput(tempDir, ["ls-files"]);
      expect(files).not.toContain("AGENTS.md");
      expect(files).not.toContain("CLAUDE.md");
    });
    
    test("preserves other files in PR branch", async () => {
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      await pr({ silent: true });
      
      // Check that test file still exists
      expect(await fileExists(join(tempDir, "test.txt"))).toBe(true);
      
      const files = await getGitOutput(tempDir, ["ls-files"]);
      expect(files).toContain("test.txt");
    });
  });
  
  describe("branch updates", () => {
    test("updates existing PR branch", async () => {
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "First commit");
      
      // Create initial PR branch
      await pr({ silent: true });
      
      // Remove AGENTS.md and CLAUDE.md files from working directory
      await Bun.spawn(["rm", "-f", "AGENTS.md", "CLAUDE.md"], { cwd: tempDir }).exited;
      
      // Go back to feature branch and add another commit
      await Bun.spawn(["git", "checkout", "-f", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Second commit");
      
      // Update PR branch
      await pr({ silent: true });
      
      // Verify we're on PR branch
      const currentBranch = await getCurrentBranch(tempDir);
      expect(currentBranch).toBe("feature--PR");
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
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => logs.push(args.join(" "));
      
      await pr({ silent: true });
      
      console.log = originalLog;
      
      expect(logs.length).toBe(0);
    });
    
    test("without silent flag produces output", async () => {
      await Bun.spawn(["git", "checkout", "-b", "feature"], { cwd: tempDir }).exited;
      await createCommit(tempDir, "Feature commit");
      
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => logs.push(args.join(" "));
      
      await pr({ silent: false });
      
      console.log = originalLog;
      
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some(log => log.includes("PR branch"))).toBe(true);
    });
  });
});
