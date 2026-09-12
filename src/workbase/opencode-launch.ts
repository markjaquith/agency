import { Schema } from "@effect/schema"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { FileSystemService } from "../services/FileSystemService"

const Session = Schema.Struct({
	id: Schema.String.pipe(Schema.pattern(/^ses/)),
	location: Schema.Struct({ directory: Schema.String }),
})
const Created = Schema.Struct({ data: Session })
const Listed = Schema.Struct({ data: Schema.Array(Session) })
const Admitted = Schema.Struct({
	data: Schema.Struct({
		id: Schema.String,
		sessionID: Schema.String,
		type: Schema.Literal("user"),
	}),
})

// V2's TUI --prompt only seeds the composer. Submit through the same CLI's
// authenticated service connection, then attach without a prompt. Reloading or
// reconnecting the TUI cannot replay the launch input.
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
		if (argv.includes("--standalone")) {
			return yield* Effect.fail(
				new Error(
					"OpenCode auto-submit requires a shared service or --server; --standalone cannot share the API-created session with the TUI",
				),
			)
		}
		const values = new Map<string, string>()
		const attach: string[] = [cli]
		let directory: string | undefined
		for (let i = 1; i < argv.length; i++) {
			const arg = argv[i]!
			if (
				[
					"--prompt",
					"--session",
					"-s",
					"--agent",
					"--model",
					"-m",
					"--server",
				].includes(arg)
			) {
				const value = argv[++i]
				if (!value)
					return yield* Effect.fail(new Error(`Missing value for ${arg}`))
				values.set(
					arg === "-s" ? "--session" : arg === "-m" ? "--model" : arg,
					value,
				)
				if (arg === "--server") attach.push(arg, value)
			} else if (arg === "--log-level") {
				const value = argv[++i]
				if (!value)
					return yield* Effect.fail(new Error(`Missing value for ${arg}`))
				attach.push(arg, value)
			} else if (["--auto", "--print-logs"].includes(arg)) {
				attach.push(arg)
			} else if (arg !== "--continue" && arg !== "-c") {
				if (arg.startsWith("-") || directory)
					return yield* Effect.fail(
						new Error(`Unsupported OpenCode auto-submit argument: ${arg}`),
					)
				directory = arg
			}
		}
		if (directory) {
			cwd = yield* fs.realPath(resolve(cwd, directory))
			attach.push(cwd)
		}
		const prompt = values.get("--prompt")
		if (!prompt?.trim())
			return yield* Effect.fail(
				new Error("OpenCode auto-submit requires a nonempty --prompt"),
			)
		const modelArgument = values.get("--model")
		const modelMatch = modelArgument?.match(/^([^/]+)\/([^#]+)(?:#(.+))?$/)
		if (modelArgument && !modelMatch)
			return yield* Effect.fail(
				new Error("OpenCode model must be provider/model#variant"),
			)
		const server = values.get("--server")
		const api = (method: string, path: string, body?: unknown) =>
			run([
				"api",
				...(server ? ["--server", server] : []),
				method,
				path,
				...(body === undefined ? [] : ["--data", JSON.stringify(body)]),
			])
		let session: typeof Session.Type | undefined
		const requestedSession = values.get("--session")
		if (requestedSession) {
			const existing = yield* Schema.decodeUnknown(Schema.parseJson(Created))(
				yield* api(
					"get",
					`/api/session/${encodeURIComponent(requestedSession)}`,
				),
			)
			session = existing.data
		} else if (argv.includes("--continue") || argv.includes("-c")) {
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
		const agent = values.get("--agent")
		if (agent) yield* api("post", `/api/session/${session.id}/agent`, { agent })
		if (modelMatch) {
			yield* api("post", `/api/session/${session.id}/model`, {
				model: {
					providerID: modelMatch[1],
					id: modelMatch[2],
					...(modelMatch[3] ? { variant: modelMatch[3] } : {}),
				},
			})
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
		const id = `msg_${randomUUID().replaceAll("-", "")}`
		const submitted = yield* Schema.decodeUnknown(Schema.parseJson(Admitted))(
			yield* api("post", `/api/session/${session.id}/prompt`, {
				id,
				text: prompt,
				resume: true,
			}),
		)
		if (submitted.data.id !== id || submitted.data.sessionID !== session.id) {
			return yield* Effect.fail(
				new Error(
					`OpenCode did not confirm the launch prompt for ${session.id}`,
				),
			)
		}
		return [...attach, "--session", session.id]
	})
