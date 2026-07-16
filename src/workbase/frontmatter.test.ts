import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { parseFrontmatter } from "./frontmatter"

describe("parseFrontmatter", () => {
	test("parses YAML 1.2 frontmatter and body", async () => {
		const parsed = await Effect.runPromise(
			parseFrontmatter(
				"---\nrepo: agency\npr: null\n---\n\n# Task\n",
				"TASK.md",
			),
		)

		expect(parsed.data).toEqual({ repo: "agency", pr: null })
		expect(parsed.body).toBe("\n# Task\n")
	})

	test("rejects duplicate keys", async () => {
		await expect(
			Effect.runPromise(
				parseFrontmatter("---\nrepo: agency\nrepo: effect\n---\n", "TASK.md"),
			),
		).rejects.toThrow("Map keys must be unique")
	})

	test("rejects anchors and aliases", async () => {
		await expect(
			Effect.runPromise(
				parseFrontmatter(
					"---\nrepo: &repo agency\nrepos:\n  - *repo\n---\n",
					"TASK.md",
				),
			),
		).rejects.toThrow("not supported")
	})

	test("rejects custom tags", async () => {
		await expect(
			Effect.runPromise(
				parseFrontmatter("---\nrepo: !custom agency\n---\n", "TASK.md"),
			),
		).rejects.toThrow()
	})

	test("requires frontmatter at the start of the document", async () => {
		await expect(
			Effect.runPromise(parseFrontmatter("# Task\n", "TASK.md")),
		).rejects.toThrow("must begin with YAML frontmatter")
	})
})
