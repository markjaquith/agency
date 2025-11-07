import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgencyConfig {
  prBranch: string;
}

const DEFAULT_CONFIG: AgencyConfig = {
  prBranch: "%branch%--PR",
};

export function getConfigDir(): string {
  // Allow override for testing
  if (process.env.AGENCY_CONFIG_DIR) {
    return process.env.AGENCY_CONFIG_DIR;
  }
  return join(homedir(), ".config", "agency");
}

function getConfigPath(): string {
  // Allow override for testing
  if (process.env.AGENCY_CONFIG_PATH) {
    return process.env.AGENCY_CONFIG_PATH;
  }
  return join(getConfigDir(), "agency.json");
}

export async function loadConfig(configPath?: string): Promise<AgencyConfig> {
  const path = configPath || getConfigPath();
  
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }
  
  try {
    const file = Bun.file(path);
    const userConfig = await file.json();
    
    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
    };
  } catch (error) {
    // If config file is invalid JSON, return defaults
    console.error(`Warning: Could not parse config file at ${path}. Using defaults.`);
    return { ...DEFAULT_CONFIG };
  }
}

export function getDefaultConfig(): AgencyConfig {
  return { ...DEFAULT_CONFIG };
}
