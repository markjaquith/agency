import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { chmod, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir } from "../test-utils"
import { githubTicketProvider } from "../tickets/github"
import { jiraTicketProvider } from "../tickets/jira"
import {
	TicketUnavailableError,
	type TicketProvider,
} from "../tickets/provider"
import { TicketProviderRegistry } from "../tickets/registry"
import { FileSystemService } from "./FileSystemService"
import { TicketService } from "./TicketService"

const run = <A, E>(
	effect: Effect.Effect<A, E, TicketService | FileSystemService>,
	providers?: readonly TicketProvider[],
) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(
				providers
					? Layer.effect(TicketService, TicketService.make).pipe(
							Layer.provide(
								Layer.succeed(TicketProviderRegistry, { providers }),
							),
						)
					: TicketService.layer,
			),
			Effect.provide(FileSystemService.layer),
		),
	)

const fakeProvider = (
	read: TicketProvider["read"],
): TicketProvider & { calls: string[] } => {
	const calls: string[] = []
	return {
		id: "fake",
		calls,
		resolve: (url) =>
			url.startsWith("fake://")
				? { provider: "fake", key: url.slice(7), url }
				: null,
		read: (reference) => {
			calls.push(reference.key)
			return read(reference)
		},
		transitions: () => Effect.succeed({ supported: true, transitions: [] }),
	}
}

describe("ticket URL resolution", () => {
	test("recognizes Jira browse and board URLs", () => {
		expect(
			jiraTicketProvider.resolve(
				"https://gustohq.atlassian.net/browse/CAN-2024",
			),
		).toEqual({
			provider: "jira",
			key: "CAN-2024",
			url: "https://gustohq.atlassian.net/browse/CAN-2024",
		})
		expect(
			jiraTicketProvider.resolve(
				"https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=OPS-7",
			)?.key,
		).toBe("OPS-7")
		expect(
			jiraTicketProvider.resolve("https://example.com/browse/CAN-1"),
		).toBeNull()
		expect(
			jiraTicketProvider.resolve("https://acme.atlassian.net/wiki/x"),
		).toBeNull()
	})

	test("recognizes GitHub issue URLs only", () => {
		expect(
			githubTicketProvider.resolve(
				"https://github.com/markjaquith/agency/issues/303",
			),
		).toEqual({
			provider: "github",
			key: "markjaquith/agency#303",
			url: "https://github.com/markjaquith/agency/issues/303",
		})
		expect(
			githubTicketProvider.resolve(
				"https://github.com/markjaquith/agency/pull/303",
			),
		).toBeNull()
	})
})

describe("TicketService", () => {
	test("reports missing and unrecognized ticket URLs explicitly", async () => {
		const [none, unsupported] = await run(
			Effect.gen(function* () {
				const service = yield* TicketService
				return [
					yield* service.read(null),
					yield* service.read("https://example.com/ticket/1"),
				]
			}),
			[],
		)
		expect(none).toEqual({ url: null, state: "none" })
		expect(unsupported).toEqual({
			url: "https://example.com/ticket/1",
			state: "unsupported",
			reason: "No ticket provider recognizes this URL",
		})
	})

	test("caches reads and converts provider failures to unavailable", async () => {
		const provider = fakeProvider((reference) =>
			reference.key === "broken"
				? Effect.fail(
						new TicketUnavailableError({
							provider: "fake",
							message: "fake CLI missing",
						}),
					)
				: Effect.succeed({
						key: reference.key,
						url: reference.url,
						status: "Doing",
						statusCategory: "in_progress",
						summary: "Fake",
						resolution: null,
					}),
		)
		const records = await run(
			Effect.gen(function* () {
				const service = yield* TicketService
				yield* service.read("fake://one")
				return yield* service.readMany([
					"fake://one",
					"fake://broken",
					"fake://broken",
					null,
				])
			}),
			[provider],
		)
		expect(provider.calls).toEqual(["one", "broken"])
		expect(records.get("fake://one")).toEqual({
			url: "fake://one",
			state: "available",
			provider: "fake",
			key: "one",
			status: "Doing",
			statusCategory: "in_progress",
			summary: "Fake",
			resolution: null,
		})
		expect(records.get("fake://broken")).toEqual({
			url: "fake://broken",
			state: "unavailable",
			provider: "fake",
			key: "broken",
			reason: "fake CLI missing",
		})
	})

	test("bounds concurrent provider reads", async () => {
		let active = 0
		let maximum = 0
		const provider = fakeProvider((reference) =>
			Effect.gen(function* () {
				active += 1
				maximum = Math.max(maximum, active)
				yield* Effect.sleep(5)
				active -= 1
				return {
					key: reference.key,
					url: reference.url,
					status: "Open",
					statusCategory: "todo" as const,
					summary: reference.key,
					resolution: null,
				}
			}),
		)
		const records = await run(
			TicketService.pipe(
				Effect.flatMap((service) =>
					service.readMany(
						Array.from({ length: 20 }, (_, index) => `fake://${index}`),
					),
				),
			),
			[provider],
		)
		expect(records.size).toBe(20)
		expect(maximum).toBe(8)
	})
})

describe("CLI ticket providers", () => {
	let bin: string
	let originalPath: string | undefined

	beforeEach(async () => {
		bin = join(await createTempDir(), "bin")
		await mkdir(bin)
		originalPath = process.env.PATH
		process.env.PATH = `${bin}:${originalPath}`
	})

	afterEach(async () => {
		if (originalPath === undefined) delete process.env.PATH
		else process.env.PATH = originalPath
		await cleanupTempDir(join(bin, ".."))
	})

	const script = async (name: string, body: string) => {
		await Bun.write(join(bin, name), `#!/bin/sh\n${body}\n`)
		await chmod(join(bin, name), 0o755)
	}

	test("reads Jira work items through acli", async () => {
		await script(
			"acli",
			`printf '%s\\n' "$*" >> "${bin}/acli.log"
case "$4" in
CAN-1) cat <<'JSON'
{"key":"CAN-1","fields":{"summary":"Ship it","status":{"name":"Done","statusCategory":{"key":"done"}},"resolution":{"name":"Fixed"}}}
JSON
;;
CAN-2) cat <<'JSON'
{"key":"CAN-2","fields":{"summary":"Build it","status":{"name":"In Review","statusCategory":{"key":"indeterminate"}},"resolution":null}}
JSON
;;
*) echo "Issue does not exist" >&2; exit 1 ;;
esac`,
		)
		const [records, transitions] = await run(
			Effect.gen(function* () {
				const service = yield* TicketService
				return [
					yield* service.readMany([
						"https://acme.atlassian.net/browse/CAN-1",
						"https://acme.atlassian.net/browse/CAN-2",
						"https://acme.atlassian.net/browse/CAN-3",
					]),
					yield* service.transitions("https://acme.atlassian.net/browse/CAN-1"),
				] as const
			}),
		)
		expect(await Bun.file(join(bin, "acli.log")).text()).toContain(
			"jira workitem view CAN-1 --fields summary,status,resolution --json",
		)
		expect(records.get("https://acme.atlassian.net/browse/CAN-1")).toEqual({
			url: "https://acme.atlassian.net/browse/CAN-1",
			state: "available",
			provider: "jira",
			key: "CAN-1",
			status: "Done",
			statusCategory: "done",
			summary: "Ship it",
			resolution: "Fixed",
		})
		expect(
			records.get("https://acme.atlassian.net/browse/CAN-2"),
		).toMatchObject({
			status: "In Review",
			statusCategory: "in_progress",
			resolution: null,
		})
		expect(records.get("https://acme.atlassian.net/browse/CAN-3")).toEqual({
			url: "https://acme.atlassian.net/browse/CAN-3",
			state: "unavailable",
			provider: "jira",
			key: "CAN-3",
			reason: "Issue does not exist",
		})
		expect(transitions.supported).toBe(false)
	})

	test("reads GitHub issues and their transitions through gh", async () => {
		await script(
			"gh",
			`printf '%s\\n' "$*" >> "${bin}/gh.log"
if [ "$3" = 7 ]; then
  printf '{"number":7,"title":"Old","state":"CLOSED","stateReason":"NOT_PLANNED","url":"https://github.com/o/r/issues/7"}\\n'
else
  printf '{"number":8,"title":"New","state":"OPEN","stateReason":"","url":"https://github.com/o/r/issues/8"}\\n'
fi`,
		)
		const [closed, open, transitions] = await run(
			Effect.gen(function* () {
				const service = yield* TicketService
				return [
					yield* service.read("https://github.com/o/r/issues/7"),
					yield* service.read("https://github.com/o/r/issues/8"),
					yield* service.transitions("https://github.com/o/r/issues/8"),
				] as const
			}),
		)
		expect(await Bun.file(join(bin, "gh.log")).text()).toContain(
			"issue view 7 --repo o/r --json number,title,state,stateReason,url",
		)
		expect(closed).toEqual({
			url: "https://github.com/o/r/issues/7",
			state: "available",
			provider: "github",
			key: "o/r#7",
			status: "CLOSED",
			statusCategory: "done",
			summary: "Old",
			resolution: "NOT_PLANNED",
		})
		expect(open).toMatchObject({ statusCategory: "todo", resolution: null })
		expect(transitions).toEqual({
			supported: true,
			transitions: [
				expect.objectContaining({ id: "close" }),
				expect.objectContaining({ id: "close-not-planned" }),
			],
		})
	})

	test("reports a missing CLI as unavailable", async () => {
		process.env.PATH = bin
		const record = await run(
			TicketService.pipe(
				Effect.flatMap((service) =>
					service.read("https://github.com/o/r/issues/9"),
				),
			),
		)
		expect(record).toMatchObject({
			state: "unavailable",
			provider: "github",
			key: "o/r#9",
		})
		expect(record.state === "unavailable" && record.reason).toContain(
			"Could not run 'gh'",
		)
	})
})
