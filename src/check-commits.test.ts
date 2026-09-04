import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "./test-utils"

const checkCommits = join(import.meta.dir, "../scripts/check-commits")

describe("check-commits", () => {
	let root: string

	function git(...args: string[]): void {
		const result = Bun.spawnSync(["git", ...args], { cwd: root })
		if (result.exitCode !== 0) {
			throw new Error(new TextDecoder().decode(result.stderr))
		}
	}

	function commit(subject: string, file: string): void {
		writeFileSync(join(root, file), `${subject}\n`)
		git("add", file)
		git("commit", "-m", subject)
	}

	beforeEach(async () => {
		root = await createTempDir()
		git("init", "--initial-branch=main")
		git("config", "user.email", "agency@example.com")
		git("config", "user.name", "Agency Test")
		commit("chore: initial commit", "initial.txt")
		git("update-ref", "refs/remotes/origin/main", "HEAD")
	})

	afterEach(async () => cleanupTempDir(root))

	test("allows merge commits with non-conventional subjects", () => {
		git("checkout", "-b", "feature")
		commit("feat: add feature", "feature.txt")
		git("checkout", "-b", "topic", "main")
		commit("fix: add topic", "topic.txt")
		git("checkout", "feature")
		git("merge", "--no-ff", "topic", "-m", "Combine topic into feature")

		const result = Bun.spawnSync([checkCommits], { cwd: root })

		expect(result.exitCode).toBe(0)
	})

	test("rejects non-conventional non-merge commits", () => {
		commit("not a conventional commit", "invalid.txt")

		const result = Bun.spawnSync([checkCommits], { cwd: root })

		expect(result.exitCode).toBe(1)
		expect(new TextDecoder().decode(result.stderr)).toContain(
			"not a conventional commit",
		)
	})
})
