// Opt-in smoke test: runs the real OpenCode TUI under its server's PTY API
// without sending keyboard input. Leaves its fixture and messages as evidence.
import { mkdtemp, mkdir, chmod, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const checkout = resolve(import.meta.dir, "..")
const agencyExecutable =
	process.env.AGENCY_SMOKE_EXECUTABLE ?? join(checkout, "cli.ts")
const temporary = process.env.AGENCY_SMOKE_TMPDIR ?? join(tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
const root = await realpath(
	await mkdtemp(join(temporary, "agency-opencode-auto-")),
)
const env = { ...process.env }
for (const key of Object.keys(env))
	if (key.startsWith("AGENCY_") || key.startsWith("HERDR_")) delete env[key]
const run = async (args: string[], cwd = root) => {
	const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" })
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	])
	if (code)
		throw new Error(`${args.slice(0, 3).join(" ")}: ${stderr || stdout}`)
	return stdout
}
const agency = (...args: string[]) => run(["bun", agencyExecutable, ...args])
const completed = (messages: any[]) =>
	messages.some(
		(message) =>
			message.type === "assistant" &&
			message.time?.completed &&
			message.finish === "stop" &&
			message.content?.some(
				(part: any) =>
					part.type === "text" && part.text === "AGENCY_AUTO_SMOKE_EXECUTED",
			),
	)
const shellOutput = (messages: any[]) =>
	messages
		.filter((message) => message.type === "assistant")
		.flatMap((message) => message.content ?? [])
		.filter(
			(part) =>
				part.type === "tool" &&
				part.name === "shell" &&
				part.state?.status === "completed",
		)
		.flatMap((part) => part.state.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
const api = async (method: string, path: string, body?: unknown) => {
	const output = await run([
		"opencode",
		"api",
		method,
		path,
		...(body === undefined ? [] : ["--data", JSON.stringify(body)]),
	])
	return output.trim() ? JSON.parse(output) : undefined
}
const source = join(root, "source")
const workbase = join(root, "workbase")
await run(["git", "init", "--initial-branch=main", source])
await Bun.write(
	join(source, "README.md"),
	"Controlled auto-start smoke fixture.\n",
)
await run(["git", "-C", source, "add", "."])
await run([
	"git",
	"-C",
	source,
	"-c",
	"user.name=Smoke",
	"-c",
	"user.email=smoke@example.com",
	"-c",
	"commit.gpgsign=false",
	"commit",
	"-m",
	"initial",
])
await run(["git", "clone", "--bare", source, join(root, "source.git")])
const portProbe = Bun.listen({
	hostname: "127.0.0.1",
	port: 0,
	socket: { data() {} },
})
const port = portProbe.port
portProbe.stop(true)
const daemon = Bun.spawn(
	[
		"git",
		"daemon",
		"--reuseaddr",
		"--export-all",
		`--base-path=${root}`,
		"--listen=127.0.0.1",
		`--port=${port}`,
		root,
	],
	{ stdout: "ignore", stderr: "ignore" },
)
let terminalID: string | undefined
let terminalQuery = ""
try {
	await agency("init", workbase, "--json")
	await run(["git", "init", "--initial-branch=main", workbase])
	await run(
		[
			"bun",
			agencyExecutable,
			"repo",
			"add",
			"smoke",
			`git://127.0.0.1:${port}/source.git`,
			"--json",
		],
		workbase,
	)
	await run(
		[
			"bun",
			agencyExecutable,
			"task",
			"create",
			"startup",
			"--repo",
			"smoke",
			"--base",
			"main",
			"--description",
			`Controlled startup verification. Run the shell command printf 'AGENCY_SESSION_ID=%s\\nAGENCY_TARGET=%s\\nHERDR_ENV=%s\\n' "$AGENCY_SESSION_ID" "$AGENCY_TARGET" "\${HERDR_ENV:-}" and then respond with exactly AGENCY_AUTO_SMOKE_EXECUTED. Do not edit files, launch agents, or change task status.`,
			"--json",
		],
		workbase,
	)
	const directory = join(workbase, "tasks/startup")
	const bin = join(root, "bin")
	await mkdir(bin)
	await Bun.write(
		join(bin, "agency"),
		`#!/bin/sh\nexec bun '${agencyExecutable}' "$@"\n`,
	)
	await chmod(join(bin, "agency"), 0o755)
	env.PATH = `${bin}:${env.PATH}`
	terminalQuery = `?directory=${encodeURIComponent(directory)}`
	const terminal = await api("post", `/api/pty${terminalQuery}`, {
		command: "/usr/bin/env",
		args: [
			...Object.keys(process.env)
				.filter((key) => key.startsWith("AGENCY_") || key.startsWith("HERDR_"))
				.flatMap((key) => ["-u", key]),
			`PATH=${env.PATH}`,
			"agency",
			"work",
			".",
			"--auto",
			"--agent",
			"opencode",
		],
		cwd: directory,
	})
	terminalID = terminal.data.id
	const query = new URLSearchParams({ directory, parentID: "null" })
	const deadline = Date.now() + 120_000
	let sessionID: string | undefined
	let messages: any[] = []
	while (Date.now() < deadline) {
		const sessions = await api("get", `/api/session?${query}`)
		sessionID = sessions.data[0]?.id
		if (sessionID) {
			const response = await api("get", `/api/session/${sessionID}/message`)
			messages = response.data ?? []
			if (completed(messages)) break
		}
		await Bun.sleep(1000)
	}
	await Bun.write(
		join(root, "messages.json"),
		JSON.stringify(messages, null, 2),
	)
	const users = messages.filter((message) => message.type === "user")
	if (users.length !== 1 || !completed(messages)) {
		throw new Error(`No verified assistant completion; inspect ${root}`)
	}
	const output = shellOutput(messages)
	if (
		!/^AGENCY_SESSION_ID=.+$/m.test(output) ||
		!/^AGENCY_TARGET=execution-unit:task\/startup$/m.test(output) ||
		!/^HERDR_ENV=$/m.test(output)
	) {
		throw new Error(
			`Session shell environment was not propagated or contains Herdr identity; inspect ${root}`,
		)
	}
	if (
		(
			await run(["git", "status", "--porcelain"], join(directory, "code/smoke"))
		).trim()
	)
		throw new Error("Smoke worker changed its checkout")
	const evidence = {
		agencyExecutable: await realpath(agencyExecutable),
		root,
		sessionID,
		terminalID,
		userMessages: users.length,
		assistantCompleted: true,
		shellEnvironmentVerified: true,
		checkoutClean: true,
		keyboardInputBytes: 0,
	}
	await Bun.write(
		join(root, "evidence.json"),
		JSON.stringify(evidence, null, 2),
	)
	console.log(JSON.stringify(evidence, null, 2))
} finally {
	if (terminalID) await api("delete", `/api/pty/${terminalID}${terminalQuery}`)
	daemon.kill()
	console.log(`Smoke evidence: ${root}`)
}
