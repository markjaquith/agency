import { describe, expect, test } from "bun:test"
import { parseCli } from "./cli-parser"

const expectUsageError = (args: string[], usage: string) => {
	expect(() => parseCli(args)).toThrow(`Usage: ${usage}`)
}

describe("strict CLI parsing", () => {
	test("rejects misspelled and command-inapplicable options", () => {
		expectUsageError(["task", "list", "--josn"], "agency task")
		expectUsageError(
			["task", "list", "--repo", "agency"],
			"agency task list [--json]",
		)
		expectUsageError(["status", "--draft"], "agency status [--json]")
	})

	test("rejects duplicate scalar, boolean, and single-value multiple options", () => {
		for (const args of [
			["status", "--json", "--json"],
			["task", "create", "example", "--repo", "one", "--repo", "two"],
			[
				"task",
				"create",
				"example",
				"--repo",
				"one",
				"--base",
				"a",
				"--base",
				"b",
			],
			["status", "-s", "--silent"],
		]) {
			expect(() => parseCli(args)).toThrow("may only be specified once")
		}
	})

	test("preserves explicitly repeatable options", () => {
		expect(
			parseCli([
				"epic",
				"create",
				"delivery",
				"--ticket-url",
				"https://example.com",
				"--repo",
				"one:main",
				"--repo",
				"two:main",
			]).values.repo,
		).toEqual(["one:main", "two:main"])
		expect(
			parseCli([
				"phase",
				"create",
				"task",
				"phase",
				"--repo",
				"one",
				"--branch",
				"feature",
				"--base",
				"main",
				"--reference",
				"two:main",
				"--reference",
				"three:main",
				"--depends-on",
				"first",
				"--depends-on",
				"second",
			]).values,
		).toMatchObject({
			reference: ["two:main", "three:main"],
			"depends-on": ["first", "second"],
		})
	})

	test("enforces exact maximum positional arity for every leaf command", () => {
		for (const [args, usage] of [
			[["init", "one", "two"], "agency init"],
			[["workbase", "add", "one", "two"], "agency workbase add"],
			[["workbase", "list", "extra"], "agency workbase list"],
			[["integration", "status", "extra"], "agency integration status"],
			[["integration", "sync", "extra"], "agency integration sync"],
			[["repo", "add", "a", "b", "extra"], "agency repo add"],
			[["repo", "link", "a", "b", "extra"], "agency repo link"],
			[["repo", "list", "extra"], "agency repo list"],
			[
				[
					"epic",
					"create",
					"one",
					"two",
					"--ticket-url",
					"url",
					"--repo",
					"repo:main",
				],
				"agency epic create",
			],
			[["epic", "list", "extra"], "agency epic list"],
			[["epic", "show", "one", "two"], "agency epic show"],
			[["task", "new", "one", "two"], "agency task new"],
			[
				["task", "create", "one", "two", "--repo", "repo"],
				"agency task create",
			],
			[["task", "list", "extra"], "agency task list"],
			[["task", "show", "one", "two"], "agency task show"],
			[["task", "status", "one", "open", "extra"], "agency task status"],
			[
				[
					"phase",
					"create",
					"task",
					"phase",
					"extra",
					"--repo",
					"repo",
					"--branch",
					"branch",
					"--base",
					"main",
				],
				"agency phase create",
			],
			[["phase", "list", "one", "two"], "agency phase list"],
			[["phase", "show", "one", "two", "three"], "agency phase show"],
			[
				["phase", "status", "one", "two", "open", "extra"],
				"agency phase status",
			],
			[["archive", "epic", "one", "two"], "agency archive epic"],
			[["archive", "task", "one", "two"], "agency archive task"],
			[["archive", "phase", "one", "two", "three"], "agency archive phase"],
			[["work", "one", "two"], "agency work"],
			[["pr", "create", "one", "two", "three"], "agency pr create"],
			[["status", "extra"], "agency status"],
			[["validate", "one", "two"], "agency validate"],
			[["context", "one", "two"], "agency context"],
			[["graph", "extra"], "agency graph"],
			[["sync", "extra"], "agency sync"],
			[
				[
					"claim",
					"one",
					"two",
					"three",
					"--claimant",
					"a",
					"--runner",
					"r",
					"--session-id",
					"s",
					"--revision",
					"0".repeat(64),
				],
				"agency claim",
			],
			[
				[
					"release",
					"one",
					"two",
					"three",
					"--session-id",
					"s",
					"--revision",
					"0".repeat(64),
				],
				"agency release",
			],
			[
				[
					"finish",
					"one",
					"two",
					"three",
					"--session-id",
					"s",
					"--revision",
					"0".repeat(64),
					"--outcome",
					"done",
				],
				"agency finish",
			],
		] as const) {
			expectUsageError([...args], usage)
		}
	})

	test("parses reconciliation modes and rejects conflicting modes", () => {
		expect(parseCli(["sync", "--dry-run", "--json"])).toMatchObject({
			commandName: "sync",
			values: { "dry-run": true, json: true },
		})
		expect(parseCli(["sync", "--apply"])).toMatchObject({
			commandName: "sync",
			values: { apply: true },
		})
		expect(() => parseCli(["sync", "--dry-run", "--apply"])).toThrow(
			"cannot be combined",
		)
	})

	test("validates revision-guarded claim operations", () => {
		const revision = "0".repeat(64)
		expect(
			parseCli([
				"claim",
				"task",
				"phase",
				"--claimant",
				"orchestrator",
				"--runner",
				"agent",
				"--session-id",
				"job-1",
				"--revision",
				revision,
				"--expires-at",
				"2026-07-17T13:00:00.000Z",
			]),
		).toMatchObject({ commandName: "claim", args: ["task", "phase"] })
		expect(() =>
			parseCli(["release", "task", "--session-id", "job-1"]),
		).toThrow("--revision' is required")
		expect(() =>
			parseCli([
				"finish",
				"task",
				"--session-id",
				"job-1",
				"--revision",
				revision,
				"--outcome",
				"working",
			]),
		).toThrow("must be 'done' or 'dropped'")
	})

	test("accepts context projections and keeps compact command-local", () => {
		expect(parseCli(["context", ".", "--json", "--compact"])).toMatchObject({
			commandName: "context",
			args: ["."],
			values: { json: true, compact: true },
		})
		expectUsageError(["status", "--compact"], "agency status")
	})

	test("accepts work preparation options only for the prepare subcommand", () => {
		expect(
			parseCli(["work", "prepare", "tasks/example", "--dry-run", "--json"]),
		).toMatchObject({
			commandName: "work",
			args: ["prepare", "tasks/example"],
			values: { "dry-run": true, json: true },
		})
		expect(() => parseCli(["work", "example", "--dry-run"])).toThrow(
			"only valid with 'agency work prepare'",
		)
		expect(() => parseCli(["work", "prepare", "--opencode"])).toThrow(
			"cannot be combined",
		)
	})

	test("accepts repeatable graph filters and rejects output conflicts", () => {
		expect(
			parseCli([
				"graph",
				"--json",
				"--status",
				"open",
				"--status",
				"working",
				"--repository",
				"agency",
				"--kind",
				"task",
				"--kind",
				"phase",
				"--include",
				"bodies",
				"--include",
				"git",
			]).values,
		).toMatchObject({
			json: true,
			status: ["open", "working"],
			repository: ["agency"],
			kind: ["task", "phase"],
			include: ["bodies", "git"],
		})
		expect(() => parseCli(["graph", "--json", "--jsonl"])).toThrow(
			"cannot be combined",
		)
		expect(() => parseCli(["graph", "--ready", "--blocked"])).toThrow(
			"cannot be combined",
		)
		for (const [option, value] of [
			["status", "started"],
			["kind", "worktree"],
			["include", "secrets"],
		] as const) {
			expect(() => parseCli(["graph", `--${option}`, value])).toThrow(
				`Invalid '--${option}' value`,
			)
		}
	})

	test("reports unknown subcommands with parent usage", () => {
		expect(() => parseCli(["task", "crate"])).toThrow(
			"Unknown subcommand 'crate'",
		)
		expectUsageError(
			["task", "crate"],
			"agency task <new|create|list|show|status>",
		)
	})

	test("rejects required-option omissions and explicit conflicts", () => {
		expect(() => parseCli(["task", "create", "example"])).toThrow(
			"--repo' is required",
		)
		for (const option of ["repo", "reference", "branch", "base"] as const) {
			const value = option === "reference" ? "other:main" : "value"
			expect(() =>
				parseCli([
					"task",
					"create",
					"example",
					"--multi-phase",
					`--${option}`,
					value,
				]),
			).toThrow("cannot be combined")
		}
		expect(() =>
			parseCli(["task", "new", "example", "--multi-phase", "--repo", "repo"]),
		).toThrow("cannot be combined")
		expect(() => parseCli(["work", "--opencode", "--claude"])).toThrow(
			"cannot be combined",
		)
		expect(() => parseCli(["work", "task", "--epic", "epic"])).toThrow(
			"cannot be combined",
		)
		expect(() => parseCli(["status", "--silent", "--verbose"])).toThrow(
			"cannot be combined",
		)
	})

	test("accepts the global interaction control on every command", () => {
		expect(parseCli(["--no-input", "task", "new"]).values["no-input"]).toBe(
			true,
		)
		expect(parseCli(["work", "--no-input"]).values["no-input"]).toBe(true)
		expect(parseCli(["validate", "--no-input"]).values["no-input"]).toBe(true)
		expect(parseCli(["status", "--no-input"]).values["no-input"]).toBe(true)
		expect(
			parseCli(["task", "create", "example", "--repo", "repo", "--no-input"])
				.values["no-input"],
		).toBe(true)
	})

	test("accepts grouped global short options before a command", () => {
		const parsed = parseCli(["-sh", "task"])
		expect(parsed.values).toMatchObject({ silent: true, help: true })
	})
})
