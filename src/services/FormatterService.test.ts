import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { Effect } from "effect"
import { FormatterService } from "../services/FormatterService"
import { createTempDir, cleanupTempDir, runTestEffect } from "../test-utils"

describe("FormatterService", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await createTempDir()
	})

	afterEach(async () => {
		await cleanupTempDir(tempDir)
	})

	describe("detectPackageManager", () => {
		test("returns null when no package.json exists", async () => {
			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectPackageManager(tempDir)
				}),
			)
			expect(result).toBeNull()
		})

		test("detects bun from bun.lockb", async () => {
			await Bun.write(join(tempDir, "package.json"), "{}")
			await Bun.write(join(tempDir, "bun.lockb"), "")

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectPackageManager(tempDir)
				}),
			)
			expect(result).toBe("bun")
		})

		test("detects bun from bun.lock", async () => {
			await Bun.write(join(tempDir, "package.json"), "{}")
			await Bun.write(join(tempDir, "bun.lock"), "")

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectPackageManager(tempDir)
				}),
			)
			expect(result).toBe("bun")
		})

		test("detects yarn from yarn.lock", async () => {
			await Bun.write(join(tempDir, "package.json"), "{}")
			await Bun.write(join(tempDir, "yarn.lock"), "")

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectPackageManager(tempDir)
				}),
			)
			expect(result).toBe("yarn")
		})

		test("detects pnpm from pnpm-lock.yaml", async () => {
			await Bun.write(join(tempDir, "package.json"), "{}")
			await Bun.write(join(tempDir, "pnpm-lock.yaml"), "")

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectPackageManager(tempDir)
				}),
			)
			expect(result).toBe("pnpm")
		})

		test("detects npm from package-lock.json", async () => {
			await Bun.write(join(tempDir, "package.json"), "{}")
			await Bun.write(join(tempDir, "package-lock.json"), "{}")

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectPackageManager(tempDir)
				}),
			)
			expect(result).toBe("npm")
		})

		test("defaults to npm when package.json exists but no lock file", async () => {
			await Bun.write(join(tempDir, "package.json"), "{}")

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectPackageManager(tempDir)
				}),
			)
			expect(result).toBe("npm")
		})

		test("bun.lockb takes priority over yarn.lock", async () => {
			await Bun.write(join(tempDir, "package.json"), "{}")
			await Bun.write(join(tempDir, "bun.lockb"), "")
			await Bun.write(join(tempDir, "yarn.lock"), "")

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectPackageManager(tempDir)
				}),
			)
			expect(result).toBe("bun")
		})
	})

	describe("detectFormatter", () => {
		test("returns null when no package.json exists", async () => {
			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectFormatter(tempDir)
				}),
			)
			expect(result).toBeNull()
		})

		test("detects prettier in devDependencies", async () => {
			await Bun.write(
				join(tempDir, "package.json"),
				JSON.stringify({
					devDependencies: { prettier: "^3.0.0" },
				}),
			)

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectFormatter(tempDir)
				}),
			)
			expect(result).toBe("prettier")
		})

		test("detects prettier in dependencies", async () => {
			await Bun.write(
				join(tempDir, "package.json"),
				JSON.stringify({
					dependencies: { prettier: "^3.0.0" },
				}),
			)

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectFormatter(tempDir)
				}),
			)
			expect(result).toBe("prettier")
		})

		test("detects oxfmt in devDependencies", async () => {
			await Bun.write(
				join(tempDir, "package.json"),
				JSON.stringify({
					devDependencies: { oxfmt: "^0.1.0" },
				}),
			)

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectFormatter(tempDir)
				}),
			)
			expect(result).toBe("oxfmt")
		})

		test("oxfmt takes priority over prettier", async () => {
			await Bun.write(
				join(tempDir, "package.json"),
				JSON.stringify({
					devDependencies: { prettier: "^3.0.0", oxfmt: "^0.1.0" },
				}),
			)

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectFormatter(tempDir)
				}),
			)
			expect(result).toBe("oxfmt")
		})

		test("returns null when no formatter is in dependencies", async () => {
			await Bun.write(
				join(tempDir, "package.json"),
				JSON.stringify({
					devDependencies: { typescript: "^5.0.0" },
				}),
			)

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectFormatter(tempDir)
				}),
			)
			expect(result).toBeNull()
		})

		test("handles malformed package.json gracefully", async () => {
			await Bun.write(join(tempDir, "package.json"), "not valid json")

			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.detectFormatter(tempDir)
				}),
			)
			expect(result).toBeNull()
		})
	})

	describe("buildFormatterCommand", () => {
		test("builds prettier command with bun", async () => {
			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.buildFormatterCommand("prettier", "bun", [
						"/path/to/file.md",
					])
				}),
			)
			expect(result).toEqual([
				"bun",
				"x",
				"prettier",
				"--write",
				"/path/to/file.md",
			])
		})

		test("builds prettier command with yarn", async () => {
			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.buildFormatterCommand("prettier", "yarn", [
						"/path/to/file.md",
					])
				}),
			)
			expect(result).toEqual([
				"yarn",
				"dlx",
				"prettier",
				"--write",
				"/path/to/file.md",
			])
		})

		test("builds prettier command with pnpm", async () => {
			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.buildFormatterCommand("prettier", "pnpm", [
						"/path/to/file.md",
					])
				}),
			)
			expect(result).toEqual([
				"pnpm",
				"exec",
				"prettier",
				"--write",
				"/path/to/file.md",
			])
		})

		test("builds prettier command with npm", async () => {
			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.buildFormatterCommand("prettier", "npm", [
						"/path/to/file.md",
					])
				}),
			)
			expect(result).toEqual(["npx", "prettier", "--write", "/path/to/file.md"])
		})

		test("builds oxfmt command with bun", async () => {
			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.buildFormatterCommand("oxfmt", "bun", [
						"/path/to/file.json",
					])
				}),
			)
			expect(result).toEqual(["bun", "x", "oxfmt", "/path/to/file.json"])
		})

		test("handles multiple files", async () => {
			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.buildFormatterCommand("prettier", "bun", [
						"/path/to/file.md",
						"/path/to/file.json",
					])
				}),
			)
			expect(result).toEqual([
				"bun",
				"x",
				"prettier",
				"--write",
				"/path/to/file.md",
				"/path/to/file.json",
			])
		})

		test("returns null for empty file list", async () => {
			const result = await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					return yield* service.buildFormatterCommand("prettier", "bun", [])
				}),
			)
			expect(result).toBeNull()
		})
	})

	describe("formatFiles", () => {
		test("silently does nothing when no package.json exists", async () => {
			const logs: string[] = []
			const verboseLog = (msg: string) => logs.push(msg)

			await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					yield* service.formatFiles(tempDir, ["AGENTS.md"], verboseLog)
				}),
			)

			expect(logs.some((l) => l.includes("No formatter"))).toBe(true)
		})

		test("silently does nothing when no formatter in package.json", async () => {
			await Bun.write(
				join(tempDir, "package.json"),
				JSON.stringify({ devDependencies: { typescript: "^5.0.0" } }),
			)

			const logs: string[] = []
			const verboseLog = (msg: string) => logs.push(msg)

			await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					yield* service.formatFiles(tempDir, ["AGENTS.md"], verboseLog)
				}),
			)

			expect(logs.some((l) => l.includes("No formatter"))).toBe(true)
		})

		test("filters to only md/json/jsonc files", async () => {
			const logs: string[] = []
			const verboseLog = (msg: string) => logs.push(msg)

			await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					yield* service.formatFiles(
						tempDir,
						["somefile.ts", "other.txt"],
						verboseLog,
					)
				}),
			)

			expect(logs.some((l) => l.includes("No formattable files"))).toBe(true)
		})

		test("does nothing with empty file list", async () => {
			const logs: string[] = []
			const verboseLog = (msg: string) => logs.push(msg)

			await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					yield* service.formatFiles(tempDir, [], verboseLog)
				}),
			)

			expect(logs.some((l) => l.includes("No files to format"))).toBe(true)
		})

		test("silently handles formatter command failure", async () => {
			// Set up a project with prettier but no actual prettier installed
			await Bun.write(
				join(tempDir, "package.json"),
				JSON.stringify({ devDependencies: { prettier: "^3.0.0" } }),
			)
			await Bun.write(join(tempDir, "bun.lockb"), "")
			await Bun.write(join(tempDir, "AGENTS.md"), "# Test")

			const logs: string[] = []
			const verboseLog = (msg: string) => logs.push(msg)

			// Should not throw even though prettier isn't actually installed
			await runTestEffect(
				Effect.gen(function* () {
					const service = yield* FormatterService
					yield* service.formatFiles(tempDir, ["AGENTS.md"], verboseLog)
				}),
			)

			// Should have detected the formatter and attempted to run it
			expect(logs.some((l) => l.includes("Detected formatter: prettier"))).toBe(
				true,
			)
		})
	})
})
