import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { use } from "./use";
import { createTempDir, cleanupTempDir, initGitRepo } from "../test-utils";
import { getGitConfig } from "../utils/git";

describe("use command", () => {
  let tempDir: string;
  let originalCwd: string;
  let originalConfigDir: string | undefined;
  
  beforeEach(async () => {
    tempDir = await createTempDir();
    originalCwd = process.cwd();
    originalConfigDir = process.env.AGENCY_CONFIG_DIR;
    // Use a temp config dir
    process.env.AGENCY_CONFIG_DIR = await createTempDir();
  });
  
  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalConfigDir !== undefined) {
      process.env.AGENCY_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.AGENCY_CONFIG_DIR;
    }
    if (process.env.AGENCY_CONFIG_DIR && process.env.AGENCY_CONFIG_DIR !== originalConfigDir) {
      await cleanupTempDir(process.env.AGENCY_CONFIG_DIR);
    }
    await cleanupTempDir(tempDir);
  });
  
  test("sets template name in git config", async () => {
    await initGitRepo(tempDir);
    process.chdir(tempDir);
    
    await use({ template: "work", silent: true });
    
    const templateName = await getGitConfig("agency.template", tempDir);
    expect(templateName).toBe("work");
  });
  
  test("updates existing template name", async () => {
    await initGitRepo(tempDir);
    process.chdir(tempDir);
    
    await use({ template: "work", silent: true });
    await use({ template: "personal", silent: true });
    
    const templateName = await getGitConfig("agency.template", tempDir);
    expect(templateName).toBe("personal");
  });
  
  test("throws error when not in git repo", async () => {
    process.chdir(tempDir);
    
    await expect(use({ template: "work", silent: true })).rejects.toThrow("Not in a git repository");
  });
  
  test("throws error when no template provided in silent mode", async () => {
    await initGitRepo(tempDir);
    process.chdir(tempDir);
    
    await expect(use({ silent: true })).rejects.toThrow("Template name required");
  });
  
  test("works with --template flag", async () => {
    await initGitRepo(tempDir);
    process.chdir(tempDir);
    
    await use({ template: "client", silent: true });
    
    const templateName = await getGitConfig("agency.template", tempDir);
    expect(templateName).toBe("client");
  });
});
