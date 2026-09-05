import { describe, expect, test } from "bun:test"
import { join } from "node:path"

interface PackResult {
	files: Array<{ path: string }>
}

describe("npm package", () => {
	test("ships public exports without test-only files", async () => {
		const process = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {
			cwd: join(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "pipe",
		})
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
		])
		expect(stderr).toBe("")
		expect(exitCode).toBe(0)

		const results = JSON.parse(stdout) as PackResult[]
		expect(results).toHaveLength(1)
		const { files } = results[0]!
		const paths = files.map((file) => file.path)

		expect(paths.filter((path) => /\.test\.tsx?$/.test(path))).toEqual([])
		expect(paths).not.toContain("src/test-utils.ts")
		expect(paths).not.toContain("fixtures/protocol/orchestration-recipes.json")
		expect(paths).toEqual(
			expect.arrayContaining([
				"index.ts",
				"src/protocol.ts",
				"schemas/agency-envelope-v1.schema.json",
				"schemas/agency-graph-v1.schema.json",
				"schemas/agency-execution-v1.schema.json",
				"fixtures/protocol/success.json",
				"fixtures/protocol/error.json",
			]),
		)
	})
})
