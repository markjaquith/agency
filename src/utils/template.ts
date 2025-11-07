import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { getConfigDir } from "../config";

/**
 * Get the directory path for a template
 */
export function getTemplateDir(templateName: string): string {
  return join(getConfigDir(), "templates", templateName);
}

/**
 * Check if a template exists
 */
export async function templateExists(templateName: string): Promise<boolean> {
  const templateDir = getTemplateDir(templateName);
  const file = Bun.file(join(templateDir, "AGENTS.md"));
  return await file.exists();
}

/**
 * Create a template directory
 */
export async function createTemplateDir(templateName: string): Promise<void> {
  const templateDir = getTemplateDir(templateName);
  await mkdir(templateDir, { recursive: true });
}

/**
 * List all available templates
 */
export async function listTemplates(): Promise<string[]> {
  const templatesDir = join(getConfigDir(), "templates");
  
  try {
    const entries = await Array.fromAsync(
      new Bun.Glob("*/AGENTS.md").scan({ cwd: templatesDir })
    );
    
    // Extract template names from paths like "work/AGENTS.md"
    return entries.map(entry => entry.split("/")[0] || "").filter(Boolean);
  } catch {
    return [];
  }
}
