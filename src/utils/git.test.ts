import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { realpath } from "fs/promises";
import { isInsideGitRepo, getGitRoot, isGitRoot } from "../utils/git";
import { createTempDir, cleanupTempDir, initGitRepo, createSubdir } from "../test-utils";

describe("git utilities", () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = await createTempDir();
  });
  
  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });
  
  describe("isInsideGitRepo", () => {
    test("returns true when inside a git repository", async () => {
      await initGitRepo(tempDir);
      const result = await isInsideGitRepo(tempDir);
      expect(result).toBe(true);
    });
    
    test("returns true when in a subdirectory of a git repository", async () => {
      await initGitRepo(tempDir);
      const subdir = await createSubdir(tempDir, "subdir");
      const result = await isInsideGitRepo(subdir);
      expect(result).toBe(true);
    });
    
    test("returns false when not in a git repository", async () => {
      const result = await isInsideGitRepo(tempDir);
      expect(result).toBe(false);
    });
  });
  
  describe("getGitRoot", () => {
    test("returns the git root when at repository root", async () => {
      await initGitRepo(tempDir);
      const result = await getGitRoot(tempDir);
      const expected = await realpath(tempDir);
      expect(result).toBe(expected);
    });
    
    test("returns the git root when in a subdirectory", async () => {
      await initGitRepo(tempDir);
      const subdir = await createSubdir(tempDir, "subdir");
      const result = await getGitRoot(subdir);
      const expected = await realpath(tempDir);
      expect(result).toBe(expected);
    });
    
    test("returns null when not in a git repository", async () => {
      const result = await getGitRoot(tempDir);
      expect(result).toBe(null);
    });
  });
  
  describe("isGitRoot", () => {
    test("returns true when path is a git repository root", async () => {
      await initGitRepo(tempDir);
      const result = await isGitRoot(tempDir);
      expect(result).toBe(true);
    });
    
    test("returns false when path is a subdirectory of a git repository", async () => {
      await initGitRepo(tempDir);
      const subdir = await createSubdir(tempDir, "subdir");
      const result = await isGitRoot(subdir);
      expect(result).toBe(false);
    });
    
    test("returns false when path is not in a git repository", async () => {
      const result = await isGitRoot(tempDir);
      expect(result).toBe(false);
    });
  });
});
