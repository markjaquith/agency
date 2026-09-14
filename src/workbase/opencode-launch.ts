import { Schema } from "@effect/schema"
import { Effect } from "effect"
import { FileSystemService } from "../services/FileSystemService"

const Session = Schema.Struct({
	id: Schema.String.pipe(Schema.pattern(/^ses/)),
	location: Schema.Struct({ directory: Schema.String }),
})
const Created = Schema.Struct({ data: Session })
const Listed = Schema.Struct({ data: Schema.Array(Session) })
const Admitted = Schema.Struct({
	data: Schema.Struct({
		sessionID: Schema.String,
		type: Schema.Literal("user"),
	}),
})

// V2's TUI --prompt only seeds the composer. Submit through the same CLI's
// authenticated service connection, then attach without a prompt. Reloading or
// reconnecting the TUI cannot replay the launch input. Only built-in Agency
// auto-command templates call this helper: [cli, [--continue], --prompt, text].
export const prepareOpenCodeLaunch = (
	argv: readonly string[],
	cwd: string,
	env: Record<string, string>,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		cwd = yield* fs.realPath(cwd)
		const cli = argv[0]!
		const run = (args: readonly string[]) =>
			Effect.gen(function* () {
				const result = yield* fs
					.runCommand([cli, ...args], {
						cwd,
						env,
						captureOutput: true,
						timeoutMs: 60_000,
					})
					.pipe(
						Effect.mapError(
							() =>
								new Error(
									`OpenCode auto-start command failed: ${args.slice(0, args.indexOf("--data") < 0 ? args.length : args.indexOf("--data")).join(" ")}`,
								),
						),
					)
				if (result.exitCode !== 0) {
					return yield* Effect.fail(
						new Error(
							`OpenCode auto-start failed (${args.slice(0, 3).join(" ")}): ${result.stderr}`,
						),
					)
				}
				return result.stdout
			})
		const version = (yield* run(["--version"])).trim()
		if (/^(?:opencode\s+v?)?1\./.test(version)) return [...argv]
		if (!/^(?:opencode\s+v?)?2\./.test(version)) {
			return yield* Effect.fail(
				new Error(`Unsupported OpenCode version for auto-start: ${version}`),
			)
		}
		const api = (method: string, path: string, body?: unknown) =>
			run([
				"api",
				method,
				path,
				...(body === undefined ? [] : ["--data", JSON.stringify(body)]),
			])
		let session: typeof Session.Type | undefined
		if (argv.includes("--continue")) {
			const query = new URLSearchParams({
				directory: cwd,
				parentID: "null",
				order: "desc",
				limit: "1",
			})
			const listed = yield* Schema.decodeUnknown(Schema.parseJson(Listed))(
				yield* api("get", `/api/session?${query}`),
			)
			session = listed.data[0]
		}
		if (!session) {
			const created = yield* Schema.decodeUnknown(Schema.parseJson(Created))(
				yield* api("post", "/api/session", { location: { directory: cwd } }),
			)
			session = created.data
		}
		if ((yield* fs.realPath(session.location.directory)) !== cwd) {
			return yield* Effect.fail(
				new Error(
					`OpenCode returned a session outside the launch directory: ${session.id}`,
				),
			)
		}
		// API client environment is not session environment on the shared server.
		// Replace it before admission so the first shell/tool sees the caller's
		// Agency identity and (for a real Herdr launch) the correct pane identity.
		const variables = Object.fromEntries(
			Object.entries({ ...process.env, ...env }).filter(
				(entry): entry is [string, string] => entry[1] !== undefined,
			),
		)
		yield* api("put", `/api/session/${session.id}/environment`, { variables })
		const submitted = yield* Schema.decodeUnknown(Schema.parseJson(Admitted))(
			yield* api("post", `/api/session/${session.id}/prompt`, {
				text: argv.at(-1)!,
				resume: true,
			}),
		)
		if (submitted.data.sessionID !== session.id) {
			return yield* Effect.fail(
				new Error(
					`OpenCode did not confirm the launch prompt for ${session.id}`,
				),
			)
		}
		return [cli, "--session", session.id]
	})
