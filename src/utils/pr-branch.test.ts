import { describe, test, expect } from "bun:test"
import { makePrBranchName, extractSourceBranch, isPrBranch } from "./pr-branch"

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

describe("isPrBranch", () => {
	test("returns true for PR branches", () => {
		expect(isPrBranch("feature-foo--PR", "%branch%--PR")).toBe(true)
		expect(isPrBranch("PR/feature-foo", "PR/%branch%")).toBe(true)
		expect(isPrBranch("feature-foo--PR", "--PR")).toBe(true)
	})

	test("returns false for non-PR branches", () => {
		expect(isPrBranch("feature-foo", "%branch%--PR")).toBe(false)
		expect(isPrBranch("main", "%branch%--PR")).toBe(false)
		expect(isPrBranch("feature-foo", "--PR")).toBe(false)
	})

	test("returns false for empty source branch", () => {
		expect(isPrBranch("--PR", "%branch%--PR")).toBe(false)
		expect(isPrBranch("PR/", "PR/%branch%")).toBe(false)
	})
})
