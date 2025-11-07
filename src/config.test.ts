import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, getDefaultConfig } from "./config"

describe("config", () => {
	let originalConfigPath: string | undefined

	beforeEach(() => {
		// Save original config path
		originalConfigPath = process.env.AGENCY_CONFIG_PATH
		// Set to non-existent path for testing
		process.env.AGENCY_CONFIG_PATH = join(tmpdir(), "non-existent-config.json")
	})

	afterEach(() => {
		// Restore original config path
		if (originalConfigPath) {
			process.env.AGENCY_CONFIG_PATH = originalConfigPath
		} else {
			delete process.env.AGENCY_CONFIG_PATH
		}
	})

	describe("getDefaultConfig", () => {
		test("returns default configuration", () => {
			const config = getDefaultConfig()
			expect(config.prBranch).toBe("%branch%--PR")
		})
	})

	describe("loadConfig", () => {
		test("returns default config when config file doesn't exist", async () => {
			const config = await loadConfig()
			expect(config.prBranch).toBe("%branch%--PR")
		})

		test("returns valid config structure", async () => {
			const config = await loadConfig()
			expect(config).toHaveProperty("prBranch")
			expect(typeof config.prBranch).toBe("string")
		})
	})
})
