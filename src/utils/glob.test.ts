import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	isGlobPattern,
	matchesGlob,
	expandGlobs,
	dirToGlobPattern,
	getTopLevelDir,
} from "./glob"

describe("isGlobPattern", () => {
	test("returns true for patterns with asterisk", () => {
		expect(isGlobPattern("*.ts")).toBe(true)
		expect(isGlobPattern("**/*.ts")).toBe(true)
		expect(isGlobPattern("plans/*")).toBe(true)
		expect(isGlobPattern("plans/**")).toBe(true)
	})

	test("returns true for patterns with question mark", () => {
		expect(isGlobPattern("file?.ts")).toBe(true)
	})

	test("returns true for patterns with character classes", () => {
		expect(isGlobPattern("[abc].ts")).toBe(true)
		expect(isGlobPattern("file[0-9].ts")).toBe(true)
	})

	test("returns false for plain file paths", () => {
		expect(isGlobPattern("foo.ts")).toBe(false)
		expect(isGlobPattern("plans/README.md")).toBe(false)
		expect(isGlobPattern("src/utils/glob.ts")).toBe(false)
	})
})

describe("matchesGlob", () => {
	test("matches files with simple wildcard", () => {
		expect(matchesGlob("*.ts", "file.ts")).toBe(true)
		expect(matchesGlob("*.ts", "file.js")).toBe(false)
	})

	test("matches files in directories with **", () => {
		expect(matchesGlob("plans/**", "plans/foo.md")).toBe(true)
		expect(matchesGlob("plans/**", "plans/sub/bar.md")).toBe(true)
		expect(matchesGlob("plans/**", "other/foo.md")).toBe(false)
	})

	test("matches nested directory patterns", () => {
		expect(matchesGlob("src/**/*.ts", "src/utils/glob.ts")).toBe(true)
		expect(matchesGlob("src/**/*.ts", "src/glob.ts")).toBe(true)
		expect(matchesGlob("src/**/*.ts", "lib/glob.ts")).toBe(false)
	})
})

describe("dirToGlobPattern", () => {
	test("converts directory to glob pattern", () => {
		expect(dirToGlobPattern("plans")).toBe("plans/**")
		expect(dirToGlobPattern("src/components")).toBe("src/components/**")
	})

	test("removes trailing slash before adding glob", () => {
		expect(dirToGlobPattern("plans/")).toBe("plans/**")
		expect(dirToGlobPattern("plans//")).toBe("plans/**")
	})
})

describe("getTopLevelDir", () => {
	test("returns top-level directory from path", () => {
		expect(getTopLevelDir("plans/foo.md")).toBe("plans")
		expect(getTopLevelDir("plans/sub/bar.md")).toBe("plans")
		expect(getTopLevelDir("src/utils/glob.ts")).toBe("src")
	})

	test("returns null for root-level files", () => {
		expect(getTopLevelDir("README.md")).toBe(null)
		expect(getTopLevelDir("file.ts")).toBe(null)
	})
})

describe("expandGlobs", () => {
	let tempDir: string

	beforeAll(async () => {
		// Create temp directory with test files
		tempDir = await mkdtemp(join(tmpdir(), "glob-test-"))

		// Create directory structure:
		// tempDir/
		//   plans/
		//     foo.md
		//     sub/
		//       bar.md
		//   other/
		//     baz.md
		//   root.txt
		await mkdir(join(tempDir, "plans"))
		await mkdir(join(tempDir, "plans", "sub"))
		await mkdir(join(tempDir, "other"))

		await writeFile(join(tempDir, "plans", "foo.md"), "foo")
		await writeFile(join(tempDir, "plans", "sub", "bar.md"), "bar")
		await writeFile(join(tempDir, "other", "baz.md"), "baz")
		await writeFile(join(tempDir, "root.txt"), "root")
	})

	afterAll(async () => {
		await rm(tempDir, { recursive: true })
	})

	test("expands glob pattern to matching files", async () => {
		const files = await expandGlobs(["plans/**"], tempDir)
		expect(files.sort()).toEqual(["plans/foo.md", "plans/sub/bar.md"].sort())
	})

	test("preserves non-glob paths as-is", async () => {
		const files = await expandGlobs(["root.txt"], tempDir)
		expect(files).toEqual(["root.txt"])
	})

	test("combines glob and non-glob patterns", async () => {
		const files = await expandGlobs(["plans/**", "root.txt"], tempDir)
		expect(files.sort()).toEqual(
			["plans/foo.md", "plans/sub/bar.md", "root.txt"].sort(),
		)
	})

	test("deduplicates results", async () => {
		const files = await expandGlobs(
			["plans/**", "plans/foo.md", "plans/**"],
			tempDir,
		)
		// Should not have duplicates
		const uniqueFiles = [...new Set(files)]
		expect(files.length).toBe(uniqueFiles.length)
	})

	test("returns non-glob paths even if they don't exist", async () => {
		const files = await expandGlobs(["nonexistent.txt"], tempDir)
		expect(files).toEqual(["nonexistent.txt"])
	})

	test("returns empty array for non-matching glob", async () => {
		const files = await expandGlobs(["nonexistent/**"], tempDir)
		expect(files).toEqual([])
	})

	test("handles multiple glob patterns", async () => {
		const files = await expandGlobs(["plans/**", "other/**"], tempDir)
		expect(files.sort()).toEqual(
			["plans/foo.md", "plans/sub/bar.md", "other/baz.md"].sort(),
		)
	})
})
