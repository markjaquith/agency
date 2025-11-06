import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { init } from "../commands/init";
import { createTempDir, cleanupTempDir, initGitRepo, createSubdir, fileExists, readFile } from "../test-utils";

describe("init command", () => {
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
    test("creates AGENTS.md and CLAUDE.md at git root", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      await init({ silent: true });
      
      expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true);
      expect(await fileExists(join(tempDir, "CLAUDE.md"))).toBe(true);
    });
    
    test("creates AGENTS.md as blank file", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      await init({ silent: true });
      
      const content = await readFile(join(tempDir, "AGENTS.md"));
      expect(content).toBe("");
    });
    
    test("creates CLAUDE.md with @AGENTS.md content", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      await init({ silent: true });
      
      const content = await readFile(join(tempDir, "CLAUDE.md"));
      expect(content).toBe("@AGENTS.md");
    });
    
    test("creates files at git root even when run from subdirectory", async () => {
      await initGitRepo(tempDir);
      const subdir = await createSubdir(tempDir, "subdir");
      process.chdir(subdir);
      
      await init({ silent: true });
      
      expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true);
      expect(await fileExists(join(tempDir, "CLAUDE.md"))).toBe(true);
      expect(await fileExists(join(subdir, "AGENTS.md"))).toBe(false);
      expect(await fileExists(join(subdir, "CLAUDE.md"))).toBe(false);
    });
    
    test("does not overwrite existing AGENTS.md", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      const existingContent = "# Existing content";
      await Bun.write(join(tempDir, "AGENTS.md"), existingContent);
      
      await init({ silent: true });
      
      const content = await readFile(join(tempDir, "AGENTS.md"));
      expect(content).toBe(existingContent);
    });
    
    test("does not overwrite existing CLAUDE.md", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      const existingContent = "# Existing content";
      await Bun.write(join(tempDir, "CLAUDE.md"), existingContent);
      
      await init({ silent: true });
      
      const content = await readFile(join(tempDir, "CLAUDE.md"));
      expect(content).toBe(existingContent);
    });
    
    test("throws error when not in a git repository", async () => {
      process.chdir(tempDir);
      
      await expect(init({ silent: true })).rejects.toThrow("Not in a git repository");
    });
  });
  
  describe("with path argument", () => {
    test("creates files at specified git root", async () => {
      await initGitRepo(tempDir);
      
      await init({ path: tempDir, silent: true });
      
      expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true);
      expect(await fileExists(join(tempDir, "CLAUDE.md"))).toBe(true);
    });
    
    test("throws error when path is not a git repository root", async () => {
      await initGitRepo(tempDir);
      const subdir = await createSubdir(tempDir, "subdir");
      
      expect(init({ path: subdir, silent: true })).rejects.toThrow("Not a git repository root");
    });
    
    test("throws error when path is not a git repository at all", async () => {
      expect(init({ path: tempDir, silent: true })).rejects.toThrow("Not a git repository root");
    });
    
    test("resolves relative paths correctly", async () => {
      await initGitRepo(tempDir);
      const subdir = await createSubdir(tempDir, "subdir");
      process.chdir(subdir);
      
      await init({ path: "..", silent: true });
      
      expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true);
      expect(await fileExists(join(tempDir, "CLAUDE.md"))).toBe(true);
    });
  });
  
  describe("silent mode", () => {
    test("silent flag suppresses output", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      // Capture console.log calls
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => logs.push(args.join(" "));
      
      await init({ silent: true });
      
      console.log = originalLog;
      
      expect(logs.length).toBe(0);
      expect(await fileExists(join(tempDir, "AGENTS.md"))).toBe(true);
      expect(await fileExists(join(tempDir, "CLAUDE.md"))).toBe(true);
    });
    
    test("without silent flag produces output", async () => {
      await initGitRepo(tempDir);
      process.chdir(tempDir);
      
      // Capture console.log calls
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: any[]) => logs.push(args.join(" "));
      
      await init({ silent: false });
      
      console.log = originalLog;
      
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some(log => log.includes("Created"))).toBe(true);
    });
  });
});
