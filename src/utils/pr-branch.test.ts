import { describe, test, expect, afterEach } from "bun:test"
import {
	makeSourceBranchName,
	extractCleanBranch,
	makeEmitBranchName,
	extractCleanFromEmit,
	resolveBranchPairWithAgencyJson,
} from "./pr-branch"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	runTestEffect,
} from "../test-utils"
import { join } from "path"

describe("makeSourceBranchName", () => {
	test("replaces %branch% placeholder with branch name", () => {
		expect(makeSourceBranchName("main", "agency/%branch%")).toBe("agency/main")
		expect(makeSourceBranchName("feature-foo", "wip/%branch%")).toBe(
			"wip/feature-foo",
		)
		expect(makeSourceBranchName("main", "%branch%/dev")).toBe("main/dev")
	})

	test("treats pattern as prefix when %branch% is not present", () => {
		expect(makeSourceBranchName("main", "agency/")).toBe("agency/main")
		expect(makeSourceBranchName("feature-foo", "wip-")).toBe("wip-feature-foo")
	})

	test("handles empty branch name", () => {
		expect(makeSourceBranchName("", "agency/%branch%")).toBe("agency/")
		expect(makeSourceBranchName("", "agency/")).toBe("agency/")
	})
})

describe("extractCleanBranch", () => {
	describe("with %branch% placeholder", () => {
		test("extracts clean branch from source branch name", () => {
			expect(extractCleanBranch("agency/main", "agency/%branch%")).toBe("main")
			expect(extractCleanBranch("wip/feature-foo", "wip/%branch%")).toBe(
				"feature-foo",
			)
			expect(extractCleanBranch("main/dev", "%branch%/dev")).toBe("main")
		})

		test("returns null when source branch name doesn't match pattern", () => {
			expect(extractCleanBranch("main", "agency/%branch%")).toBeNull()
			expect(extractCleanBranch("feature-foo", "wip/%branch%")).toBeNull()
			expect(extractCleanBranch("agency/main", "wip/%branch%")).toBeNull()
		})

		test("returns null for empty clean branch", () => {
			expect(extractCleanBranch("agency/", "agency/%branch%")).toBeNull()
			expect(extractCleanBranch("wip/", "wip/%branch%")).toBeNull()
		})

		test("handles complex patterns", () => {
			expect(
				extractCleanBranch("pr-feature-foo-ready", "pr-%branch%-ready"),
			).toBe("feature-foo")
			expect(
				extractCleanBranch("PR/feature/foo/ready", "PR/%branch%/ready"),
			).toBe("feature/foo")
		})
	})

	describe("without %branch% placeholder (prefix mode)", () => {
		test("extracts clean branch by removing prefix", () => {
			expect(extractCleanBranch("agency/main", "agency/")).toBe("main")
			expect(extractCleanBranch("wip-feature-foo", "wip-")).toBe("feature-foo")
		})

		test("returns null when branch doesn't start with prefix", () => {
			expect(extractCleanBranch("main", "agency/")).toBeNull()
			expect(extractCleanBranch("feature-foo", "wip-")).toBeNull()
		})

		test("returns null for empty clean branch", () => {
			expect(extractCleanBranch("agency/", "agency/")).toBeNull()
			expect(extractCleanBranch("wip-", "wip-")).toBeNull()
		})
	})
})

describe("makeEmitBranchName", () => {
	test("returns clean branch when pattern is %branch%", () => {
		expect(makeEmitBranchName("main", "%branch%")).toBe("main")
		expect(makeEmitBranchName("feature-foo", "%branch%")).toBe("feature-foo")
	})

	test("replaces %branch% placeholder with branch name", () => {
		expect(makeEmitBranchName("feature-foo", "%branch%--PR")).toBe(
			"feature-foo--PR",
		)
		expect(makeEmitBranchName("feature-foo", "PR/%branch%")).toBe(
			"PR/feature-foo",
		)
	})

	test("treats pattern as suffix when %branch% is not present", () => {
		expect(makeEmitBranchName("feature-foo", "--PR")).toBe("feature-foo--PR")
		expect(makeEmitBranchName("feature-foo", "-pr")).toBe("feature-foo-pr")
	})

	test("handles empty branch name", () => {
		expect(makeEmitBranchName("", "%branch%")).toBe("")
		expect(makeEmitBranchName("", "%branch%--PR")).toBe("--PR")
		expect(makeEmitBranchName("", "--PR")).toBe("--PR")
	})
})

describe("extractCleanFromEmit", () => {
	test("returns emit branch when pattern is %branch%", () => {
		expect(extractCleanFromEmit("main", "%branch%")).toBe("main")
		expect(extractCleanFromEmit("feature-foo", "%branch%")).toBe("feature-foo")
	})

	describe("with %branch% placeholder", () => {
		test("extracts clean branch from emit branch name", () => {
			expect(extractCleanFromEmit("feature-foo--PR", "%branch%--PR")).toBe(
				"feature-foo",
			)
			expect(extractCleanFromEmit("PR/feature-foo", "PR/%branch%")).toBe(
				"feature-foo",
			)
		})

		test("returns null when emit branch name doesn't match pattern", () => {
			expect(extractCleanFromEmit("feature-foo", "%branch%--PR")).toBeNull()
			expect(extractCleanFromEmit("feature-foo--PR", "PR/%branch%")).toBeNull()
			expect(extractCleanFromEmit("main", "%branch%--PR")).toBeNull()
		})

		test("returns null for empty clean branch", () => {
			expect(extractCleanFromEmit("--PR", "%branch%--PR")).toBeNull()
			expect(extractCleanFromEmit("PR/", "PR/%branch%")).toBeNull()
		})

		test("handles complex patterns", () => {
			expect(
				extractCleanFromEmit("pr-feature-foo-ready", "pr-%branch%-ready"),
			).toBe("feature-foo")
			expect(
				extractCleanFromEmit("PR/feature/foo/ready", "PR/%branch%/ready"),
			).toBe("feature/foo")
		})
	})

	describe("without %branch% placeholder (suffix mode)", () => {
		test("extracts clean branch by removing suffix", () => {
			expect(extractCleanFromEmit("feature-foo--PR", "--PR")).toBe(
				"feature-foo",
			)
			expect(extractCleanFromEmit("feature-foo-pr", "-pr")).toBe("feature-foo")
		})

		test("returns null when branch doesn't end with suffix", () => {
			expect(extractCleanFromEmit("feature-foo", "--PR")).toBeNull()
			expect(extractCleanFromEmit("PR-feature-foo", "--PR")).toBeNull()
		})

		test("returns null for empty clean branch", () => {
			expect(extractCleanFromEmit("--PR", "--PR")).toBeNull()
			expect(extractCleanFromEmit("-pr", "-pr")).toBeNull()
		})
	})
})

describe("resolveBranchPairWithAgencyJson", () => {
	let tempDir: string

	afterEach(async () => {
		if (tempDir) {
			await cleanupTempDir(tempDir)
		}
	})

	test("uses agency.json emitBranch when on source branch", async () => {
		tempDir = await createTempDir()
		await initGitRepo(tempDir)

		// Create source branch with agency.json
		await Bun.spawn(["git", "checkout", "-b", "agency/main"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		const agencyJson = {
			version: 1,
			injectedFiles: [],
			template: "test",
			createdAt: new Date().toISOString(),
			emitBranch: "main",
		}
		await Bun.write(join(tempDir, "agency.json"), JSON.stringify(agencyJson))

		const result = await runTestEffect(
			resolveBranchPairWithAgencyJson(
				tempDir,
				"agency/main",
				"agency/%branch%",
				"%branch%",
			),
		)

		expect(result.sourceBranch).toBe("agency/main")
		expect(result.emitBranch).toBe("main")
		expect(result.isOnEmitBranch).toBe(false)
	})

	test("finds source branch by searching for matching emitBranch", async () => {
		tempDir = await createTempDir()
		await initGitRepo(tempDir)

		// Create a source branch with agency.json
		await Bun.spawn(["git", "checkout", "-b", "agency/feature-bar"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		const agencyJson = {
			version: 1,
			injectedFiles: [],
			template: "test",
			createdAt: new Date().toISOString(),
			emitBranch: "feature-bar",
		}
		await Bun.write(join(tempDir, "agency.json"), JSON.stringify(agencyJson))
		await Bun.spawn(["git", "add", "agency.json"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "commit", "-m", "Add agency.json"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Create the emit branch from main (so it doesn't have agency.json)
		await Bun.spawn(["git", "checkout", "main"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "checkout", "-b", "feature-bar"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		const result = await runTestEffect(
			resolveBranchPairWithAgencyJson(
				tempDir,
				"feature-bar",
				"agency/%branch%",
				"%branch%",
			),
		)

		expect(result.sourceBranch).toBe("agency/feature-bar")
		expect(result.emitBranch).toBe("feature-bar")
		expect(result.isOnEmitBranch).toBe(true)
	})

	test("falls back to pattern-based resolution when agency.json not found", async () => {
		tempDir = await createTempDir()
		await initGitRepo(tempDir)

		// Create source branch without agency.json
		await Bun.spawn(["git", "checkout", "-b", "agency/feature-baz"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// No agency.json, should fall back to pattern-based resolution
		const result = await runTestEffect(
			resolveBranchPairWithAgencyJson(
				tempDir,
				"agency/feature-baz",
				"agency/%branch%",
				"%branch%",
			),
		)

		expect(result.sourceBranch).toBe("agency/feature-baz")
		expect(result.emitBranch).toBe("feature-baz")
		expect(result.isOnEmitBranch).toBe(false)
	})

	test("treats branch as legacy source when no matching pattern and no source branch exists", async () => {
		tempDir = await createTempDir()
		await initGitRepo(tempDir)

		// Create a branch without the source pattern (legacy branch)
		// No agency/feature-qux exists, so this is a legacy source branch
		await Bun.spawn(["git", "checkout", "-b", "feature-qux"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		const result = await runTestEffect(
			resolveBranchPairWithAgencyJson(
				tempDir,
				"feature-qux",
				"agency/%branch%",
				"%branch%",
			),
		)

		// Legacy branch is treated as source, emit is the same name (with %branch% pattern)
		expect(result.sourceBranch).toBe("feature-qux")
		expect(result.emitBranch).toBe("feature-qux")
		expect(result.isOnEmitBranch).toBe(false)
	})

	test("handles branches with no agency.json on current branch", async () => {
		tempDir = await createTempDir()
		await initGitRepo(tempDir)

		// Create source branch, no agency.json
		await Bun.spawn(["git", "checkout", "-b", "agency/main"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		// Just test pattern-based resolution with no agency.json anywhere
		const result = await runTestEffect(
			resolveBranchPairWithAgencyJson(
				tempDir,
				"agency/main",
				"agency/%branch%",
				"%branch%",
			),
		)

		expect(result.sourceBranch).toBe("agency/main")
		expect(result.emitBranch).toBe("main")
		expect(result.isOnEmitBranch).toBe(false)
	})

	test("handles emit pattern with suffix", async () => {
		tempDir = await createTempDir()
		await initGitRepo(tempDir)

		// Test with custom emit pattern that adds a suffix
		await Bun.spawn(["git", "checkout", "-b", "agency/feature"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		const result = await runTestEffect(
			resolveBranchPairWithAgencyJson(
				tempDir,
				"agency/feature",
				"agency/%branch%",
				"%branch%--PR",
			),
		)

		expect(result.sourceBranch).toBe("agency/feature")
		expect(result.emitBranch).toBe("feature--PR")
		expect(result.isOnEmitBranch).toBe(false)
	})
})
