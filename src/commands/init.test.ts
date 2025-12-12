import { test, expect, describe } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { init } from "./init"
import { initGitRepo, getGitConfig, runTestEffect } from "../test-utils"

describe("init command", () => {
	test("initializes with template flag", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await runTestEffect(
				init({ template: "test-template", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe(
				"test-template",
			)
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("saves template name to git config", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await runTestEffect(
				init({ template: "my-template", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe("my-template")
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("accepts template names with hyphens", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await runTestEffect(
				init({ template: "my-work-template", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe(
				"my-work-template",
			)
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("accepts template names with underscores", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await runTestEffect(
				init({ template: "my_work_template", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe(
				"my_work_template",
			)
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("throws error when not in git repository", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await expect(
				runTestEffect(init({ template: "test", silent: true, cwd: tempDir })),
			).rejects.toThrow("Not in a git repository")
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("throws error when already initialized without template flag", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await runTestEffect(
				init({ template: "first-template", silent: true, cwd: tempDir }),
			)
			await expect(
				runTestEffect(init({ silent: true, cwd: tempDir })),
			).rejects.toThrow("Already initialized")
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("allows re-initialization with different template", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await runTestEffect(
				init({ template: "first-template", silent: true, cwd: tempDir }),
			)
			await runTestEffect(
				init({ template: "second-template", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe(
				"second-template",
			)
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("requires template name in silent mode", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await expect(
				runTestEffect(init({ silent: true, cwd: tempDir })),
			).rejects.toThrow("Template name required")
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("sets config even if template directory does not exist", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await runTestEffect(
				init({ template: "nonexistent", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe("nonexistent")
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("works without output in silent mode", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await runTestEffect(
				init({ template: "silent-test", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe("silent-test")
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("fails in silent mode without template", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await expect(
				runTestEffect(init({ silent: true, cwd: tempDir })),
			).rejects.toThrow("Template name required")
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("works in verbose mode", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			const originalLog = console.log
			console.log = () => {}
			try {
				await runTestEffect(
					init({
						template: "verbose-test",
						verbose: true,
						silent: false,
						cwd: tempDir,
					}),
				)
				expect(await getGitConfig("agency.template", tempDir)).toBe(
					"verbose-test",
				)
			} finally {
				console.log = originalLog
			}
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("handles empty template name", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await expect(
				runTestEffect(init({ template: "", silent: true, cwd: tempDir })),
			).rejects.toThrow("Template name required")
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("handles template name with special characters", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await runTestEffect(
				init({ template: "test.template", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe(
				"test.template",
			)
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("handles very long template names", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			const longName = "a".repeat(100)
			await runTestEffect(
				init({ template: longName, silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe(longName)
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("changing template updates git config", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await runTestEffect(
				init({ template: "template-a", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe("template-a")
			await runTestEffect(
				init({ template: "template-b", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe("template-b")
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("preserves template name across command runs", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		try {
			await initGitRepo(tempDir)
			await runTestEffect(
				init({ template: "persistent", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe("persistent")
			expect(await getGitConfig("agency.template", tempDir)).toBe("persistent")
		} finally {
			await rm(tempDir, { recursive: true, force: true })
		}
	})

	test("does not create template directory during init", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		const configDir = await mkdtemp(join(tmpdir(), "agency-config-"))
		const originalConfigDir = process.env.AGENCY_CONFIG_DIR
		try {
			await initGitRepo(tempDir)
			process.env.AGENCY_CONFIG_DIR = configDir
			await runTestEffect(
				init({ template: "test-template", silent: true, cwd: tempDir }),
			)
			expect(
				await Bun.file(
					`${configDir}/templates/test-template/AGENTS.md`,
				).exists(),
			).toBe(false)
		} finally {
			if (originalConfigDir !== undefined) {
				process.env.AGENCY_CONFIG_DIR = originalConfigDir
			} else {
				delete process.env.AGENCY_CONFIG_DIR
			}
			await rm(tempDir, { recursive: true, force: true })
			await rm(configDir, { recursive: true, force: true })
		}
	})

	test("works when templates directory does not exist", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "agency-test-"))
		const originalConfigDir = process.env.AGENCY_CONFIG_DIR
		try {
			await initGitRepo(tempDir)
			// Point to a non-existent config directory
			const configDir = join(tmpdir(), `agency-config-${Date.now()}`)
			process.env.AGENCY_CONFIG_DIR = configDir
			// Verify templates directory doesn't exist
			expect(await Bun.file(join(configDir, "templates")).exists()).toBe(false)
			// Init should work even without templates directory
			await runTestEffect(
				init({ template: "new-template", silent: true, cwd: tempDir }),
			)
			expect(await getGitConfig("agency.template", tempDir)).toBe(
				"new-template",
			)
		} finally {
			if (originalConfigDir !== undefined) {
				process.env.AGENCY_CONFIG_DIR = originalConfigDir
			} else {
				delete process.env.AGENCY_CONFIG_DIR
			}
			await rm(tempDir, { recursive: true, force: true })
		}
	})
})
