import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { eject } from "../commands/eject";
import { init } from "../commands/init";
import { createTempDir, cleanupTempDir, initGitRepo, fileExists, readFile } from "../test-utils";

describe("eject command", () => {
  let tempDir: string;
  let originalCwd: string;
  
  beforeEach(async () => {
    tempDir = await createTempDir();
    originalCwd = process.cwd();
  });
  
  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  });
  
  describe("without path argument", () => {
    test("removes files from git index", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      // Create and track files
      await init({ silent: true });
      await Bun.spawn(["git", "add", "AGENTS.md", "CLAUDE.md"], {
        cwd: tempDir,
      }).exited;
      
      // Eject files
      await eject({ silent: true });
      
      // Check if files are still on disk
      expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true);
      expect(await fileExists(join(tempDir, "CLAUDE.md"))).toBe(true);
      
      // Check if files were removed from git index
      const proc = Bun.spawn(["git", "ls-files"], {
        cwd: tempDir,
        stdout: "pipe",
      });
      await proc.exited;
      const output = await new Response(proc.stdout).text();
      
      expect(output).not.toContain("AGENTS.md");
      expect(output).not.toContain("CLAUDE.md");
    });
    
    test("adds files to .gitignore", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      await init({ silent: true });
      await eject({ silent: true });
      
      const gitignoreContent = await readFile(join(tempDir, ".gitignore"));
      expect(gitignoreContent).toContain("AGENTS.md");
      expect(gitignoreContent).toContain("CLAUDE.md");
    });
    
    test("does not duplicate .gitignore entries", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      await init({ silent: true });
      await eject({ silent: true });
      await eject({ silent: true }); // Run twice
      
      const gitignoreContent = await readFile(join(tempDir, ".gitignore"));
      const lines = gitignoreContent.split("\n");
      const agentsCount = lines.filter(line => line === "AGENTS.md").length;
      const claudeCount = lines.filter(line => line === "CLAUDE.md").length;
      
      expect(agentsCount).toBe(1);
      expect(claudeCount).toBe(1);
    });
    
    test("preserves existing .gitignore content", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      const existingContent = "node_modules/\n*.log\n";
      await Bun.write(join(tempDir, ".gitignore"), existingContent);
      
      await init({ silent: true });
      await eject({ silent: true });
      
      const gitignoreContent = await readFile(join(tempDir, ".gitignore"));
      expect(gitignoreContent).toContain("node_modules/");
      expect(gitignoreContent).toContain("*.log");
      expect(gitignoreContent).toContain("AGENTS.md");
      expect(gitignoreContent).toContain("CLAUDE.md");
    });
    
    test("throws error when not in a git repository", async () => {
      process.chdir(tempDir);
      
      expect(eject({ silent: true })).rejects.toThrow("Not in a git repository");
    });
  });
  
  describe("with path argument", () => {
    test("ejects files at specified path", async () => {
      await initGitRepo(tempDir);
      
      await init({ path: tempDir, silent: true });
      await Bun.spawn(["git", "add", "AGENTS.md", "CLAUDE.md"], {
        cwd: tempDir,
      }).exited;
      
      await eject({ path: tempDir, silent: true });
      
      // Check if files are still on disk
      expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true);
      expect(await fileExists(join(tempDir, "CLAUDE.md"))).toBe(true);
      
      // Check .gitignore
      const gitignoreContent = await readFile(join(tempDir, ".gitignore"));
      expect(gitignoreContent).toContain("AGENTS.md");
      expect(gitignoreContent).toContain("CLAUDE.md");
    });
  });
  
  describe("silent mode", () => {
    test("silent flag suppresses output", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      await init({ silent: true });
      
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => logs.push(args.join(" "));
      
      await eject({ silent: true });
      
      console.log = originalLog;
      
      expect(logs.length).toBe(0);
    });
    
    test("without silent flag produces output", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      await init({ silent: true });
      
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => logs.push(args.join(" "));
      
      await eject({ silent: false });
      
      console.log = originalLog;
      
      expect(logs.length).toBeGreaterThan(0);
    });
  });
});
