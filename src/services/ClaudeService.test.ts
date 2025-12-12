import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import { join } from "path"
import {
	createTempDir,
	cleanupTempDir,
	initGitRepo,
	runTestEffect,
	fileExists,
	readFile,
	createFile,
} from "../test-utils"
import { ClaudeService } from "./ClaudeService"

describe("ClaudeService", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await createTempDir()
		await initGitRepo(tempDir)
	})

	afterEach(async () => {
		await cleanupTempDir(tempDir)
	})

	describe("claudeFileExists", () => {
		test("returns false when CLAUDE.md does not exist", async () => {
			const result = await runTestEffect(
				Effect.gen(function* () {
					const claudeService = yield* ClaudeService
					return yield* claudeService.claudeFileExists(tempDir)
				}),
			)

			expect(result).toBe(false)
		})

		test("returns true when CLAUDE.md exists", async () => {
			await createFile(tempDir, "CLAUDE.md", "# Claude Code\n")

			const result = await runTestEffect(
				Effect.gen(function* () {
					const claudeService = yield* ClaudeService
					return yield* claudeService.claudeFileExists(tempDir)
				}),
			)

			expect(result).toBe(true)
		})
	})

	describe("hasAgencySection", () => {
		test("returns false when content does not have agency section", async () => {
			const content = "# Claude Code\n\nSome instructions\n"

			const result = await runTestEffect(
				Effect.gen(function* () {
					const claudeService = yield* ClaudeService
					return yield* claudeService.hasAgencySection(content)
				}),
			)

			expect(result).toBe(false)
		})

		test("returns true when content has both @AGENCY.md and @TASK.md", async () => {
			const content = `# Claude Code

Some instructions

## Agency

@AGENCY.md
@TASK.md
`

			const result = await runTestEffect(
				Effect.gen(function* () {
					const claudeService = yield* ClaudeService
					return yield* claudeService.hasAgencySection(content)
				}),
			)

			expect(result).toBe(true)
		})
	})

	describe("injectAgencySection", () => {
		test("creates CLAUDE.md with agency section when file does not exist", async () => {
			const result = await runTestEffect(
				Effect.gen(function* () {
					const claudeService = yield* ClaudeService
					return yield* claudeService.injectAgencySection(tempDir)
				}),
			)

			expect(result.created).toBe(true)
			expect(result.modified).toBe(true)

			const claudePath = join(tempDir, "CLAUDE.md")
			expect(await fileExists(claudePath)).toBe(true)

			const content = await readFile(claudePath)
			expect(content).toContain("@AGENCY.md")
			expect(content).toContain("@TASK.md")
			expect(content.indexOf("@AGENCY.md")).toBeLessThan(
				content.indexOf("@TASK.md"),
			)
		})

		test("appends agency section when file exists without references", async () => {
			const initialContent = "# Claude Code\n\nSome existing instructions\n"
			await createFile(tempDir, "CLAUDE.md", initialContent)

			const result = await runTestEffect(
				Effect.gen(function* () {
					const claudeService = yield* ClaudeService
					return yield* claudeService.injectAgencySection(tempDir)
				}),
			)

			expect(result.created).toBe(false)
			expect(result.modified).toBe(true)

			const content = await readFile(join(tempDir, "CLAUDE.md"))
			expect(content).toContain("Some existing instructions")
			expect(content).toContain("@AGENCY.md")
			expect(content).toContain("@TASK.md")
		})

		test("does not modify file when agency section already exists in correct order", async () => {
			const contentWithSection = `# Claude Code

Some instructions

## Agency

@AGENCY.md
@TASK.md
`
			await createFile(tempDir, "CLAUDE.md", contentWithSection)

			const result = await runTestEffect(
				Effect.gen(function* () {
					const claudeService = yield* ClaudeService
					return yield* claudeService.injectAgencySection(tempDir)
				}),
			)

			expect(result.created).toBe(false)
			expect(result.modified).toBe(false)

			const content = await readFile(join(tempDir, "CLAUDE.md"))
			expect(content).toBe(contentWithSection)
		})

		test("re-adds references when they exist in wrong order", async () => {
			const contentWithWrongOrder = `# Claude Code

Some instructions

@TASK.md
@AGENCY.md
`
			await createFile(tempDir, "CLAUDE.md", contentWithWrongOrder)

			const result = await runTestEffect(
				Effect.gen(function* () {
					const claudeService = yield* ClaudeService
					return yield* claudeService.injectAgencySection(tempDir)
				}),
			)

			expect(result.created).toBe(false)
			expect(result.modified).toBe(true)

			const content = await readFile(join(tempDir, "CLAUDE.md"))
			// Should have the section appended with correct order
			expect(content).toContain("@AGENCY.md")
			expect(content).toContain("@TASK.md")
		})
	})
})
