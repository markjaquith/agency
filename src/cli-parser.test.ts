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
			"agency task list [filters] [--json]",
		)
		expectUsageError(["status", "--draft"], "agency status [filters] [--json]")
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
		expect(
			parseCli([
				"archive",
				"list",
				"--kind",
				"task",
				"--kind",
				"phase",
				"--status",
				"done",
				"--repository",
				"agency",
			]).values,
		).toMatchObject({
			kind: ["task", "phase"],
			status: ["done"],
			repository: ["agency"],
		})
		expect(
			parseCli(["restore", "task", "example", "--dry-run"]).values,
		).toMatchObject({ "dry-run": true })
	})

	test("parses composable view filters", () => {
		expect(
			parseCli([
				"task",
				"list",
				"--status",
				"open",
				"--status",
				"working",
				"--repository",
				"agency",
				"--ready",
				"--pr",
			]).values,
		).toMatchObject({
			status: ["open", "working"],
			repository: ["agency"],
			ready: true,
			pr: true,
		})
		expect(parseCli(["status", "--no-pr"]).values["no-pr"]).toBe(true)
	})

	test("parses addressable resource maintenance commands", () => {
		for (const args of [
			["doctor", "--json"],
			["repo", "show", "agency", "--json"],
			["repo", "fetch", "agency"],
			["repo", "remove", "agency"],
			["repo", "unlink", "agency"],
			["repo", "rename", "agency", "renamed"],
			["repo", "remote", "agency", "https://example.com/repo.git"],
			["repo", "verify", "agency"],
			["workbase", "show", "primary", "--json"],
			["workbase", "name", "primary", "renamed"],
			["workbase", "name", "primary", "--clear"],
		]) {
			expect(() => parseCli(args)).not.toThrow()
		}
	})

	test("validates view filter values and conflicts", () => {
		expect(() => parseCli(["epic", "list", "--status", "invalid"])).toThrow(
			"Invalid '--status' value",
		)
		expect(() =>
			parseCli(["phase", "list", "task", "--ready", "--blocked"]),
		).toThrow("cannot be combined")
		expect(() => parseCli(["status", "--pr", "--no-pr"])).toThrow(
			"cannot be combined",
		)
		expect(() => parseCli(["archive", "list", "--status", "invalid"])).toThrow(
			"Invalid '--status' value",
		)
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
			[["archive", "list", "extra"], "agency archive list"],
			[
				["archive", "show", "task", "one", "extra", "more"],
				"agency archive show",
			],
			[["restore", "epic", "one", "two"], "agency restore epic"],
			[["restore", "task", "one", "two"], "agency restore task"],
			[["restore", "phase", "one", "two", "three"], "agency restore phase"],
			[["work", "one", "two"], "agency work"],
			[["pr", "create", "one", "two", "three"], "agency pr create"],
			[["status", "extra"], "agency status"],
			[["validate", "one", "two"], "agency validate"],
			[["context", "one", "two"], "agency context"],
			[["graph", "extra"], "agency graph"],
			[["next", "extra"], "agency next"],
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

	test("parses readiness selection and explicit guard overrides", () => {
		expect(parseCli(["next", "--select", "--json"])).toMatchObject({
			commandName: "next",
			values: { select: true, json: true },
		})
		expect(parseCli(["work", "example", "--force"])).toMatchObject({
			commandName: "work",
			values: { force: true },
		})
		expect(parseCli(["pr", "create", "example", "--force"])).toMatchObject({
			commandName: "pr",
			values: { force: true },
		})
		expect(() => parseCli(["work", "prepare", "example", "--force"])).toThrow(
			"cannot be combined",
		)
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

	test("accepts archive dry-run", () => {
		expect(parseCli(["archive", "task", "example", "--dry-run"])).toMatchObject(
			{
				commandName: "archive",
				values: { "dry-run": true },
			},
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

	test("accepts valid mutation revisions and rejects malformed hashes", () => {
		const revision = "a".repeat(64)
		expect(
			parseCli([
				"task",
				"move",
				"example",
				"--no-epic",
				"--if-revision",
				revision,
			]),
		).toMatchObject({ values: { "if-revision": revision } })
		expect(() =>
			parseCli([
				"phase",
				"rename",
				"task",
				"phase",
				"renamed",
				"--if-revision",
				"stale",
			]),
		).toThrow("64-character SHA-256 hash")
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

	test("parses worktree lifecycle commands and selectors", () => {
		expect(parseCli(["worktree", "list", "--json"])).toMatchObject({
			commandName: "worktree",
			args: ["list"],
			values: { json: true },
		})
		expect(
			parseCli([
				"worktree",
				"rebuild",
				"--task",
				"example",
				"--phase",
				"verify",
				"--dry-run",
			]),
		).toMatchObject({
			commandName: "worktree",
			args: ["rebuild", "example", "verify"],
			values: { task: "example", phase: "verify", "dry-run": true },
		})
		expectUsageError(
			["worktree", "inspect", "example", "--dry-run"],
			"agency worktree inspect",
		)
		expect(() => parseCli(["worktree", "repair", "--phase", "verify"])).toThrow(
			"requires '--task'",
		)
	})

	test("accepts runner selection and command inspection for work", () => {
		expect(
			parseCli(["work", "example", "--runner", "custom", "--print-command"]),
		).toMatchObject({
			commandName: "work",
			args: ["example"],
			values: { runner: "custom", "print-command": true },
		})
		expect(() =>
			parseCli(["work", "example", "--runner", "custom", "--claude"]),
		).toThrow("cannot be combined")
		expect(() => parseCli(["work", "prepare", "--print-command"])).toThrow(
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
			"agency task <new|create|list|show|status|update|rename|move|dependency>",
		)
	})

	test("parses graph mutation commands and rejects unsafe ambiguity", () => {
		expect(
			parseCli([
				"task",
				"update",
				"example",
				"--description",
				"Revised",
				"--reference",
				"docs:main",
				"--reference",
				"api:main",
				"--clear-pr",
			]),
		).toMatchObject({
			args: ["update", "example"],
			values: {
				description: "Revised",
				reference: ["docs:main", "api:main"],
				"clear-pr": true,
			},
		})
		expect(
			parseCli(["task", "move", "example", "--no-epic"]).values,
		).toMatchObject({
			"no-epic": true,
		})
		expect(parseCli(["phase", "rename", "task", "old", "new"]).args).toEqual([
			"rename",
			"task",
			"old",
			"new",
		])
		expect(() => parseCli(["task", "update", "example"])).toThrow(
			"At least one update option",
		)
		expect(() =>
			parseCli(["task", "move", "example", "--epic", "one", "--no-epic"]),
		).toThrow("cannot be combined")
		expect(() => parseCli(["task", "dependency", "replace", "a", "b"])).toThrow(
			"must be 'add' or 'remove'",
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

	test("normalizes explicit entity selectors into command targets", () => {
		expect(
			parseCli([
				"phase",
				"status",
				"done",
				"--task",
				"ship",
				"--phase",
				"release",
			]),
		).toMatchObject({
			commandName: "phase",
			args: ["status", "ship", "release", "done"],
		})
		expect(
			parseCli([
				"claim",
				"--task",
				"ship",
				"--phase",
				"release",
				"--claimant",
				"agent",
				"--runner",
				"opencode",
				"--session-id",
				"session",
				"--revision",
				"0".repeat(64),
			]),
		).toMatchObject({ args: ["ship", "release"] })
		expect(parseCli(["context", "--epic", "delivery"]).values.epic).toBe(
			"delivery",
		)
	})

	test("enforces explicit selector precedence and exclusions", () => {
		expect(() =>
			parseCli(["task", "show", "positional", "--task", "explicit"]),
		).toThrow("cannot be combined with positional target IDs")
		expect(() => parseCli(["context", "--phase", "release"])).toThrow(
			"--phase' requires '--task",
		)
		expect(() =>
			parseCli(["work", "--epic", "delivery", "--task", "ship"]),
		).toThrow("cannot be combined with '--task'")
		expect(() =>
			parseCli(["status", "--workbase", "primary", "--cwd", "/tmp"]),
		).toThrow("--workbase' and '--cwd' cannot be combined")
	})

	test("accepts explicit workbase context before or after commands", () => {
		expect(
			parseCli(["--workbase", "primary", "task", "list", "--no-input"]).values
				.workbase,
		).toBe("primary")
		expect(parseCli(["status", "--cwd", "/tmp"]).values.cwd).toBe("/tmp")
		expect(
			parseCli(["--workbase=primary", "task", "list"]).values.workbase,
		).toBe("primary")
		expect(parseCli(["--cwd=/tmp", "status"]).values.cwd).toBe("/tmp")
	})

	test("rejects empty selectors", () => {
		for (const args of [
			["status", "--workbase="],
			["status", "--cwd="],
			["context", "--task="],
		]) {
			expect(() => parseCli(args)).toThrow("requires a non-empty value")
		}
	})

	test("accepts grouped global short options before a command", () => {
		const parsed = parseCli(["-sh", "task"])
		expect(parsed.values).toMatchObject({ silent: true, help: true })
	})
})
