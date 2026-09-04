import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { errorEnvelope } from "../protocol"
import { PushService } from "./PushService"
import { TaskService } from "./TaskService"
import { WorktreeService } from "./WorktreeService"
import { parseGitCommits } from "./push-validation"

interface CommandResult {
	readonly stdout: string
	readonly stderr: string
	readonly exitCode: number
}

const runCommand = async (
	args: readonly string[],
	cwd?: string,
): Promise<CommandResult> => {
	const child = Bun.spawn([...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	])
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

const requireCommand = async (args: readonly string[], cwd?: string) => {
	const result = await runCommand(args, cwd)
	if (result.exitCode !== 0) {
		throw new Error(`${args.join(" ")} failed: ${result.stderr}`)
	}
	return result
}

describe("PushService", () => {
	test("parses batched Git commit metadata", () => {
		const output = [
			"abc123\0Agency Test\0agency@example.com\0First change\0\x1e",
			"def456\0Agency Test\0agency@example.com\0Second change\0\x1e",
		].join("\n")
		const commits = parseGitCommits(output)

		expect(
			commits.map(({ commitId, description }) => ({ commitId, description })),
		).toEqual([
			{ commitId: "abc123", description: "First change" },
			{ commitId: "def456", description: "Second change" },
		])
		expect(commits.every((commit) => commit.authorEmail.includes("@"))).toBe(
			true,
		)
	})

	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map(cleanupTempDir))
	})

	const setup = async () => {
		const root = await createTempDir()
		roots.push(root)
		const remote = join(root, "remote.git")
		const seed = join(root, "seed")
		const repository = join(root, "repos", "agency")
		await mkdir(join(root, "repos"), { recursive: true })
		await Bun.write(join(root, "agency.json"), '{"version":2,"vcs":"git"}\n')
		await requireCommand([
			"git",
			"init",
			"--bare",
			"--initial-branch=main",
			remote,
		])
		await requireCommand(["git", "init", "--initial-branch=main", seed])
		await requireCommand(["git", "config", "user.name", "Agency Test"], seed)
		await requireCommand(
			["git", "config", "user.email", "agency@example.com"],
			seed,
		)
		await Bun.write(join(seed, "README.md"), "# Test repository\n")
		await requireCommand(["git", "add", "README.md"], seed)
		await requireCommand(["git", "commit", "-m", "Initial commit"], seed)
		await requireCommand(["git", "remote", "add", "origin", remote], seed)
		await requireCommand(["git", "push", "-u", "origin", "main"], seed)
		await requireCommand(["git", "clone", "--bare", remote, repository])

		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.create(
						{
							id: "example",
							ticketUrl: null,
							repo: "agency",
							branch: "task/example",
							base: "main",
						},
						root,
					),
				),
			),
		)
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("example", "working", root),
				),
			),
		)
		const workspace = await runTestEffect(
			WorktreeService.pipe(
				Effect.flatMap((service) =>
					service.materialize("example", undefined, root),
				),
			),
		)
		return {
			root,
			remote,
			checkout: workspace.writablePath!,
			taskPath: join(root, "tasks", "example"),
		}
	}

	const publish = (
		taskPath: string,
		options: {
			fetchTimeoutMs?: number
			pushTimeoutMs?: number
			retryDelayMs?: number
		} = {},
	) =>
		runTestEffect(
			PushService.pipe(
				Effect.flatMap((service) => service.publish(taskPath, options)),
			),
		)

	const remoteBranch = async (remote: string) =>
		(
			await requireCommand([
				"git",
				"--git-dir",
				remote,
				"rev-parse",
				"refs/heads/task/example",
			])
		).stdout

	const configureAuthor = async (checkout: string) => {
		await requireCommand(
			["git", "config", "user.name", "Agency Test"],
			checkout,
		)
		await requireCommand(
			["git", "config", "user.email", "agency@example.com"],
			checkout,
		)
	}

	const prePushHook = async (checkout: string) =>
		resolve(
			checkout,
			(
				await requireCommand(
					["git", "rev-parse", "--git-path", "hooks/pre-push"],
					checkout,
				)
			).stdout,
		)

	test("publishes a clean Git HEAD and establishes upstream tracking", async () => {
		const fixture = await setup()
		await configureAuthor(fixture.checkout)
		await Bun.write(join(fixture.checkout, "feature.txt"), "published\n")
		await requireCommand(["git", "add", "feature.txt"], fixture.checkout)
		await requireCommand(
			["git", "commit", "-m", "Add published feature"],
			fixture.checkout,
		)

		const result = await publish(fixture.taskPath)
		expect(result).toMatchObject({
			vcs: "git",
			branch: "task/example",
			base: "main",
			remote: "origin",
		})
		expect(await remoteBranch(fixture.remote)).toBe(result.tip)
		expect(
			(
				await requireCommand(
					["git", "rev-parse", "--abbrev-ref", "@{upstream}"],
					fixture.checkout,
				)
			).stdout,
		).toBe("origin/task/example")
	})

	test("rejects dirty, mismatched, and undescribed Git publication", async () => {
		const dirty = await setup()
		await Bun.write(join(dirty.checkout, "dirty.txt"), "dirty\n")
		await expect(publish(dirty.taskPath)).rejects.toThrow("dirty Git worktree")

		const mismatched = await setup()
		await requireCommand(
			["git", "branch", "-m", "wrong-branch"],
			mismatched.checkout,
		)
		await expect(publish(mismatched.taskPath)).rejects.toThrow(
			"does not match checked-out Git branch",
		)

		const undescribed = await setup()
		await configureAuthor(undescribed.checkout)
		await requireCommand(
			["git", "commit", "--allow-empty", "--allow-empty-message", "-m", ""],
			undescribed.checkout,
		)
		await expect(publish(undescribed.taskPath)).rejects.toThrow(
			"has an empty message",
		)
	})

	test("rejects Git remote divergence after refreshing remote state", async () => {
		const fixture = await setup()
		await configureAuthor(fixture.checkout)
		await Bun.write(join(fixture.checkout, "feature.txt"), "first\n")
		await requireCommand(["git", "add", "feature.txt"], fixture.checkout)
		await requireCommand(
			["git", "commit", "-m", "First change"],
			fixture.checkout,
		)
		await publish(fixture.taskPath)

		const other = join(fixture.root, "other")
		await requireCommand(["git", "clone", fixture.remote, other])
		await requireCommand(["git", "checkout", "task/example"], other)
		await requireCommand(["git", "config", "user.name", "Other"], other)
		await requireCommand(
			["git", "config", "user.email", "other@example.com"],
			other,
		)
		await Bun.write(join(other, "remote.txt"), "remote\n")
		await requireCommand(["git", "add", "remote.txt"], other)
		await requireCommand(["git", "commit", "-m", "Remote change"], other)
		await requireCommand(["git", "push", "origin", "task/example"], other)

		await Bun.write(join(fixture.checkout, "local.txt"), "local\n")
		await requireCommand(["git", "add", "local.txt"], fixture.checkout)
		await requireCommand(
			["git", "commit", "-m", "Local change"],
			fixture.checkout,
		)
		await expect(publish(fixture.taskPath)).rejects.toThrow(
			"refusing a non-fast-forward update",
		)
	})

	test("requires working status and the declared Git base in history", async () => {
		const open = await setup()
		await runTestEffect(
			TaskService.pipe(
				Effect.flatMap((service) =>
					service.setStatus("example", "open", open.root),
				),
			),
		)
		await expect(publish(open.taskPath)).rejects.toThrow(
			"status 'open'; status must be working",
		)

		const unrelated = await setup()
		await configureAuthor(unrelated.checkout)
		await requireCommand(
			["git", "checkout", "--orphan", "unrelated"],
			unrelated.checkout,
		)
		await requireCommand(["git", "rm", "-rf", "."], unrelated.checkout)
		await Bun.write(join(unrelated.checkout, "unrelated.txt"), "unrelated\n")
		await requireCommand(["git", "add", "unrelated.txt"], unrelated.checkout)
		await requireCommand(
			["git", "commit", "-m", "Unrelated history"],
			unrelated.checkout,
		)
		await requireCommand(
			["git", "branch", "-M", "task/example"],
			unrelated.checkout,
		)
		await expect(publish(unrelated.taskPath)).rejects.toThrow(
			"is not an ancestor of Git HEAD",
		)
	})

	test("rejects invalid Git authors", async () => {
		const fixture = await setup()
		await configureAuthor(fixture.checkout)
		await requireCommand(
			[
				"git",
				"commit",
				"--allow-empty",
				"--author",
				"Bad <bad>",
				"-m",
				"Invalid author",
			],
			fixture.checkout,
		)
		await expect(publish(fixture.taskPath)).rejects.toThrow(
			"has an invalid author",
		)
	})

	test("bounds a stalled pre-push hook and confirms non-publication", async () => {
		const fixture = await setup()
		await configureAuthor(fixture.checkout)
		await Bun.write(join(fixture.checkout, "feature.txt"), "timeout\n")
		await requireCommand(["git", "add", "feature.txt"], fixture.checkout)
		await requireCommand(
			["git", "commit", "-m", "Add timed publication"],
			fixture.checkout,
		)
		const hook = await prePushHook(fixture.checkout)
		await Bun.write(hook, "#!/bin/sh\nsleep 30\n")
		await chmod(hook, 0o755)

		const startedAt = performance.now()
		const failure = await publish(fixture.taskPath, {
			pushTimeoutMs: 25,
		}).catch((error) => error)
		expect(performance.now() - startedAt).toBeLessThan(1_000)
		expect(errorEnvelope(failure).error).toMatchObject({
			code: "PUSH_TIMEOUT",
			fields: { category: "timeout", stage: "publish" },
			retryable: true,
		})
		await expect(remoteBranch(fixture.remote)).rejects.toThrow()
	})

	test("classifies hook rejection separately from transport failure", async () => {
		const fixture = await setup()
		await configureAuthor(fixture.checkout)
		await Bun.write(join(fixture.checkout, "feature.txt"), "rejected\n")
		await requireCommand(["git", "add", "feature.txt"], fixture.checkout)
		await requireCommand(
			["git", "commit", "-m", "Add rejected publication"],
			fixture.checkout,
		)
		const hook = await prePushHook(fixture.checkout)
		await Bun.write(
			hook,
			"#!/bin/sh\necho 'pre-push hook declined' >&2\nexit 1\n",
		)
		await chmod(hook, 0o755)

		const failure = await publish(fixture.taskPath).catch((error) => error)
		expect(errorEnvelope(failure).error).toMatchObject({
			code: "PUSH_HOOK_REJECTED",
			fields: { category: "hook_rejection", stage: "publish" },
			retryable: false,
		})
	})

	test("retries one transient fetch with non-interactive authentication", async () => {
		const fixture = await setup()
		await configureAuthor(fixture.checkout)
		await Bun.write(join(fixture.checkout, "feature.txt"), "retried\n")
		await requireCommand(["git", "add", "feature.txt"], fixture.checkout)
		await requireCommand(
			["git", "commit", "-m", "Add retried publication"],
			fixture.checkout,
		)
		const attempts = join(fixture.root, "upload-pack-attempts")
		const uploadPack = join(fixture.root, "upload-pack")
		await Bun.write(
			uploadPack,
			`#!/bin/sh
echo x >> ${JSON.stringify(attempts)}
test "$GIT_TERMINAL_PROMPT" = 0 || exit 2
test "$GCM_INTERACTIVE" = Never || exit 2
if test "$(wc -l < ${JSON.stringify(attempts)})" -eq 1; then
  echo 'Connection reset by peer' >&2
  exit 1
fi
exec git-upload-pack "$@"
`,
		)
		await chmod(uploadPack, 0o755)
		await requireCommand(
			["git", "config", "remote.origin.uploadpack", uploadPack],
			fixture.checkout,
		)

		const result = await publish(fixture.taskPath, { retryDelayMs: 0 })
		expect(result.tip).toBe(await remoteBranch(fixture.remote))
		expect((await Bun.file(attempts).text()).trim().split("\n")).toHaveLength(2)
	})
})
