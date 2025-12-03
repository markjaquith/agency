import { describe, test, expect, afterEach } from "bun:test"
import {
	makePrBranchName,
	extractSourceBranch,
	resolveBranchPair,
	resolveBranchPairWithAgencyJson,
} from "./pr-branch"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	runTestEffect,
} from "../test-utils"
import { join } from "path"

describe("makePrBranchName", () => {
	test("replaces %branch% placeholder with branch name", () => {
		expect(makePrBranchName("feature-foo", "%branch%--PR")).toBe(
			"feature-foo--PR",
		)
		expect(makePrBranchName("feature-foo", "PR/%branch%")).toBe(
			"PR/feature-foo",
		)
		expect(makePrBranchName("feature-foo", "%branch%")).toBe("feature-foo")
	})

	test("treats pattern as suffix when %branch% is not present", () => {
		expect(makePrBranchName("feature-foo", "--PR")).toBe("feature-foo--PR")
		expect(makePrBranchName("feature-foo", "-pr")).toBe("feature-foo-pr")
	})

	test("handles empty branch name", () => {
		expect(makePrBranchName("", "%branch%--PR")).toBe("--PR")
		expect(makePrBranchName("", "--PR")).toBe("--PR")
	})
})

describe("extractSourceBranch", () => {
	describe("with %branch% placeholder", () => {
		test("extracts source branch from PR branch name", () => {
			expect(extractSourceBranch("feature-foo--PR", "%branch%--PR")).toBe(
				"feature-foo",
			)
			expect(extractSourceBranch("PR/feature-foo", "PR/%branch%")).toBe(
				"feature-foo",
			)
			expect(extractSourceBranch("feature-foo", "%branch%")).toBe("feature-foo")
		})

		test("returns null when PR branch name doesn't match pattern", () => {
			expect(extractSourceBranch("feature-foo", "%branch%--PR")).toBeNull()
			expect(extractSourceBranch("feature-foo--PR", "PR/%branch%")).toBeNull()
			expect(extractSourceBranch("main", "%branch%--PR")).toBeNull()
		})

		test("returns null for empty source branch", () => {
			expect(extractSourceBranch("--PR", "%branch%--PR")).toBeNull()
			expect(extractSourceBranch("PR/", "PR/%branch%")).toBeNull()
		})

		test("handles complex patterns", () => {
			expect(
				extractSourceBranch("pr-feature-foo-ready", "pr-%branch%-ready"),
			).toBe("feature-foo")
			expect(
				extractSourceBranch("PR/feature/foo/ready", "PR/%branch%/ready"),
			).toBe("feature/foo")
		})
	})

	describe("without %branch% placeholder (suffix mode)", () => {
		test("extracts source branch by removing suffix", () => {
			expect(extractSourceBranch("feature-foo--PR", "--PR")).toBe("feature-foo")
			expect(extractSourceBranch("feature-foo-pr", "-pr")).toBe("feature-foo")
		})

		test("returns null when branch doesn't end with suffix", () => {
			expect(extractSourceBranch("feature-foo", "--PR")).toBeNull()
			expect(extractSourceBranch("PR-feature-foo", "--PR")).toBeNull()
		})

		test("returns null for empty source branch", () => {
			expect(extractSourceBranch("--PR", "--PR")).toBeNull()
			expect(extractSourceBranch("-pr", "-pr")).toBeNull()
		})
	})
})

describe("resolveBranchPair", () => {
	test("resolves source branch correctly", () => {
		const result = resolveBranchPair("feature-foo", "%branch%--PR")

		expect(result.sourceBranch).toBe("feature-foo")
		expect(result.prBranch).toBe("feature-foo--PR")
		expect(result.isOnPrBranch).toBe(false)
	})

	test("resolves PR branch correctly", () => {
		const result = resolveBranchPair("feature-foo--PR", "%branch%--PR")

		expect(result.sourceBranch).toBe("feature-foo")
		expect(result.prBranch).toBe("feature-foo--PR")
		expect(result.isOnPrBranch).toBe(true)
	})

	test("works with prefix pattern", () => {
		const sourceResult = resolveBranchPair("feature-foo", "PR/%branch%")
		expect(sourceResult.sourceBranch).toBe("feature-foo")
		expect(sourceResult.prBranch).toBe("PR/feature-foo")
		expect(sourceResult.isOnPrBranch).toBe(false)

		const prResult = resolveBranchPair("PR/feature-foo", "PR/%branch%")
		expect(prResult.sourceBranch).toBe("feature-foo")
		expect(prResult.prBranch).toBe("PR/feature-foo")
		expect(prResult.isOnPrBranch).toBe(true)
	})

	test("works with suffix mode (no placeholder)", () => {
		const sourceResult = resolveBranchPair("feature-foo", "--PR")
		expect(sourceResult.sourceBranch).toBe("feature-foo")
		expect(sourceResult.prBranch).toBe("feature-foo--PR")
		expect(sourceResult.isOnPrBranch).toBe(false)

		const prResult = resolveBranchPair("feature-foo--PR", "--PR")
		expect(prResult.sourceBranch).toBe("feature-foo")
		expect(prResult.prBranch).toBe("feature-foo--PR")
		expect(prResult.isOnPrBranch).toBe(true)
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

		// Create agency.json with emitBranch
		const agencyJson = {
			version: 1,
			injectedFiles: [],
			template: "test",
			createdAt: new Date().toISOString(),
			emitBranch: "feature-foo--custom-pr",
		}
		await Bun.write(join(tempDir, "agency.json"), JSON.stringify(agencyJson))

		const result = await runTestEffect(
			resolveBranchPairWithAgencyJson(tempDir, "main", "%branch%--PR"),
		)

		expect(result.sourceBranch).toBe("main")
		expect(result.prBranch).toBe("feature-foo--custom-pr")
		expect(result.isOnPrBranch).toBe(false)
	})

	test("finds source branch by searching for matching emitBranch", async () => {
		tempDir = await createTempDir()
		await initGitRepo(tempDir)

		// Create a feature branch with agency.json
		await Bun.spawn(["git", "checkout", "-b", "feature-bar"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		const agencyJson = {
			version: 1,
			injectedFiles: [],
			template: "test",
			createdAt: new Date().toISOString(),
			emitBranch: "feature-bar--PR",
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

		// Create the PR branch from main (so it doesn't have agency.json)
		await Bun.spawn(["git", "checkout", "main"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited
		await Bun.spawn(["git", "checkout", "-b", "feature-bar--PR"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		const result = await runTestEffect(
			resolveBranchPairWithAgencyJson(
				tempDir,
				"feature-bar--PR",
				"%branch%--PR",
			),
		)

		expect(result.sourceBranch).toBe("feature-bar")
		expect(result.prBranch).toBe("feature-bar--PR")
		expect(result.isOnPrBranch).toBe(true)
	})

	test("falls back to pattern-based resolution when agency.json not found", async () => {
		tempDir = await createTempDir()
		await initGitRepo(tempDir)

		// No agency.json, should fall back to pattern-based resolution
		const result = await runTestEffect(
			resolveBranchPairWithAgencyJson(tempDir, "feature-baz", "%branch%--PR"),
		)

		expect(result.sourceBranch).toBe("feature-baz")
		expect(result.prBranch).toBe("feature-baz--PR")
		expect(result.isOnPrBranch).toBe(false)
	})

	test("falls back to pattern-based resolution on PR branch when no matching agency.json", async () => {
		tempDir = await createTempDir()
		await initGitRepo(tempDir)

		// Create PR branch without corresponding source branch agency.json
		await Bun.spawn(["git", "checkout", "-b", "feature-qux--PR"], {
			cwd: tempDir,
			stdout: "pipe",
			stderr: "pipe",
		}).exited

		const result = await runTestEffect(
			resolveBranchPairWithAgencyJson(
				tempDir,
				"feature-qux--PR",
				"%branch%--PR",
			),
		)

		expect(result.sourceBranch).toBe("feature-qux")
		expect(result.prBranch).toBe("feature-qux--PR")
		expect(result.isOnPrBranch).toBe(true)
	})

	test("handles branches with no agency.json on current branch", async () => {
		tempDir = await createTempDir()
		await initGitRepo(tempDir)

		// Just test pattern-based resolution with no agency.json anywhere
		const result = await runTestEffect(
			resolveBranchPairWithAgencyJson(tempDir, "main", "%branch%--PR"),
		)

		expect(result.sourceBranch).toBe("main")
		expect(result.prBranch).toBe("main--PR")
		expect(result.isOnPrBranch).toBe(false)
	})
})
