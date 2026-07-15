import { describe, expect, test } from "bun:test"
import { parseRepositoryReferences } from "./repository-reference"

describe("repository references", () => {
	test("parses alias and ref CLI values", () => {
		expect(parseRepositoryReferences(["web:origin/main"])[0]).toEqual({
			repo: "web",
			ref: "origin/main",
		})
		expect(
			parseRepositoryReferences(["web:main", "zenpayroll:v1.2.3"]),
		).toEqual([
			{ repo: "web", ref: "main" },
			{ repo: "zenpayroll", ref: "v1.2.3" },
		])
	})

	test("rejects references without both parts", () => {
		for (const value of ["web", ":main", "web:"]) {
			expect(() => parseRepositoryReferences([value])).toThrow(
				"expected <alias>:<ref>",
			)
		}
	})
})
