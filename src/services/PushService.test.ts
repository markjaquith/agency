import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupTempDir, createTempDir, runTestEffect } from "../test-utils"
import { TaskService } from "./TaskService"
import { PushService } from "./PushService"
import { WorktreeService } from "./WorktreeService"

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
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map(cleanupTempDir))
	})

	const setup = async (vcs: "git" | "jj") => {
		const root = await createTempDir()
		roots.push(root)
		const remote = join(root, "remote.git")
		const seed = join(root, "seed")
		const repository = join(root, "repos", "agency")
		await mkdir(join(root, "repos"), { recursive: true })
		await Bun.write(
			join(root, "agency.json"),
			`${JSON.stringify({ version: 2, vcs }, null, 2)}\n`,
		)
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
		if (vcs === "jj") {
			await requireCommand([
				"jj",
				"git",
				"clone",
				"--no-colocate",
				remote,
				repository,
			])
			expect(await Bun.file(join(repository, ".git")).exists()).toBe(false)
			await requireCommand(
				["jj", "config", "set", "--repo", "user.name", "Agency Test"],
				repository,
			)
			await requireCommand(
				["jj", "config", "set", "--repo", "user.email", "agency@example.com"],
				repository,
			)
		} else {
			await requireCommand(["git", "clone", "--bare", remote, repository])
		}

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

	const publish = (taskPath: string) =>
		runTestEffect(
			PushService.pipe(Effect.flatMap((service) => service.publish(taskPath))),
		)

	const remoteBranch = async (remote: string, branch = "task/example") =>
		(
			await requireCommand([
				"git",
				"--git-dir",
				remote,
				"rev-parse",
				`refs/heads/${branch}`,
			])
		).stdout

	test("publishes a clean Git HEAD and establishes upstream tracking", async () => {
		const fixture = await setup("git")
		await requireCommand(
			["git", "config", "user.name", "Agency Test"],
			fixture.checkout,
		)
		await requireCommand(
			["git", "config", "user.email", "agency@example.com"],
			fixture.checkout,
		)
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
		const dirty = await setup("git")
		await Bun.write(join(dirty.checkout, "dirty.txt"), "dirty\n")
		await expect(publish(dirty.taskPath)).rejects.toThrow("dirty Git worktree")

		const mismatched = await setup("git")
		await requireCommand(
			["git", "branch", "-m", "wrong-branch"],
			mismatched.checkout,
		)
		await expect(publish(mismatched.taskPath)).rejects.toThrow(
			"does not match checked-out Git branch",
		)

		const undescribed = await setup("git")
		await requireCommand(
			["git", "config", "user.name", "Agency Test"],
			undescribed.checkout,
		)
		await requireCommand(
			["git", "config", "user.email", "agency@example.com"],
			undescribed.checkout,
		)
		await requireCommand(
			["git", "commit", "--allow-empty", "--allow-empty-message", "-m", ""],
			undescribed.checkout,
		)
		await expect(publish(undescribed.taskPath)).rejects.toThrow(
			"has an empty message",
		)
	})

	test("rejects Git remote divergence after refreshing remote state", async () => {
		const fixture = await setup("git")
		for (const [key, value] of [
			["user.name", "Agency Test"],
			["user.email", "agency@example.com"],
		] as const) {
			await requireCommand(["git", "config", key, value], fixture.checkout)
		}
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
		const open = await setup("git")
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

		const unrelated = await setup("git")
		await requireCommand(
			["git", "config", "user.name", "Agency Test"],
			unrelated.checkout,
		)
		await requireCommand(
			["git", "config", "user.email", "agency@example.com"],
			unrelated.checkout,
		)
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

	test("rejects invalid Git and jj authors", async () => {
		const git = await setup("git")
		await requireCommand(
			["git", "config", "user.name", "Agency Test"],
			git.checkout,
		)
		await requireCommand(
			["git", "config", "user.email", "agency@example.com"],
			git.checkout,
		)
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
			git.checkout,
		)
		await expect(publish(git.taskPath)).rejects.toThrow("has an invalid author")

		if (!Bun.which("jj")) return
		const jj = await setup("jj")
		await requireCommand(
			["jj", "describe", "-m", "Invalid author"],
			jj.checkout,
		)
		await requireCommand(
			["jj", "metaedit", "--author", "Bad <bad>"],
			jj.checkout,
		)
		const changeId = (
			await requireCommand(
				["jj", "log", "--no-graph", "-r", "@", "-T", "change_id"],
				jj.checkout,
			)
		).stdout
		await expect(publish(jj.taskPath)).rejects.toThrow(
			`Change ${changeId} has an invalid author. Run: jj metaedit -r ${changeId} --author 'Name <email>'`,
		)
	})

	test("publishes a described jj working-copy change under the declared bookmark", async () => {
		if (!Bun.which("jj")) return
		const fixture = await setup("jj")
		await Bun.write(join(fixture.checkout, "feature.txt"), "published\n")
		await requireCommand(
			["jj", "describe", "-m", "Add published feature"],
			fixture.checkout,
		)

		const result = await publish(fixture.taskPath)
		expect(result).toMatchObject({
			vcs: "jj",
			branch: "task/example",
			base: "main",
			remote: "origin",
		})
		expect(await remoteBranch(fixture.remote)).toBe(result.tip)
		expect(
			(
				await requireCommand(
					[
						"jj",
						"bookmark",
						"list",
						"--all-remotes",
						"-T",
						'if(name == "task/example" && remote == "origin", tracked, "")',
					],
					fixture.checkout,
				)
			).stdout,
		).toBe("true")

		await requireCommand(["jj", "new", "@"], fixture.checkout)
		await Bun.write(join(fixture.checkout, "follow-up.txt"), "follow up\n")
		await requireCommand(
			["jj", "describe", "-m", "Add follow-up"],
			fixture.checkout,
		)
		const advanced = await publish(fixture.taskPath)
		expect(advanced.tip).not.toBe(result.tip)
		expect(await remoteBranch(fixture.remote)).toBe(advanced.tip)
	}, 15_000)

	test("diagnoses a jj stack whose remote base advanced", async () => {
		if (!Bun.which("jj")) return
		const fixture = await setup("jj")
		await Bun.write(join(fixture.checkout, "feature.txt"), "local\n")
		await requireCommand(
			["jj", "describe", "-m", "Local feature"],
			fixture.checkout,
		)

		const other = join(fixture.root, "other-main")
		await requireCommand(["git", "clone", fixture.remote, other])
		await requireCommand(["git", "config", "user.name", "Other"], other)
		await requireCommand(
			["git", "config", "user.email", "other@example.com"],
			other,
		)
		await Bun.write(join(other, "remote.txt"), "remote\n")
		await requireCommand(["git", "add", "remote.txt"], other)
		await requireCommand(["git", "commit", "-m", "Advance main"], other)
		await requireCommand(["git", "push", "origin", "main"], other)

		await expect(publish(fixture.taskPath)).rejects.toThrow(
			"jj rebase -s 'roots(main@origin..@)' -d main@origin",
		)
	})

	test("selects the described parent of a canonical jj post-commit working copy", async () => {
		if (!Bun.which("jj")) return
		const fixture = await setup("jj")
		await Bun.write(join(fixture.checkout, "feature.txt"), "published\n")
		await requireCommand(
			["jj", "commit", "-m", "Add published feature"],
			fixture.checkout,
		)
		const parent = (
			await requireCommand(
				["jj", "log", "--no-graph", "-r", "@-", "-T", "commit_id"],
				fixture.checkout,
			)
		).stdout

		const result = await publish(fixture.taskPath)
		expect(result.tip).toBe(parent)
		expect(await remoteBranch(fixture.remote)).toBe(parent)
	})

	test("preserves a described empty jj change and diagnoses missing semantics", async () => {
		if (!Bun.which("jj")) return
		const described = await setup("jj")
		await requireCommand(
			["jj", "describe", "-m", "Record intentional empty change"],
			described.checkout,
		)
		const describedTip = (
			await requireCommand(
				["jj", "log", "--no-graph", "-r", "@", "-T", "commit_id"],
				described.checkout,
			)
		).stdout
		expect((await publish(described.taskPath)).tip).toBe(describedTip)

		const undescribed = await setup("jj")
		await Bun.write(join(undescribed.checkout, "feature.txt"), "missing\n")
		const changeId = (
			await requireCommand(
				["jj", "log", "--no-graph", "-r", "@", "-T", "change_id"],
				undescribed.checkout,
			)
		).stdout
		await expect(publish(undescribed.taskPath)).rejects.toThrow(
			`Change ${changeId} has no description. Run: jj describe -r ${changeId}`,
		)
	}, 15_000)

	test("rejects an empty jj task and remote bookmark divergence", async () => {
		if (!Bun.which("jj")) return
		const empty = await setup("jj")
		await expect(publish(empty.taskPath)).rejects.toThrow(
			"No changes to publish after base 'main'",
		)

		const fixture = await setup("jj")
		await Bun.write(join(fixture.checkout, "feature.txt"), "first\n")
		await requireCommand(
			["jj", "describe", "-m", "First change"],
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

		await requireCommand(["jj", "new", "@"], fixture.checkout)
		await Bun.write(join(fixture.checkout, "local.txt"), "local\n")
		await requireCommand(
			["jj", "describe", "-m", "Local change"],
			fixture.checkout,
		)
		await expect(publish(fixture.taskPath)).rejects.toThrow(
			"refusing to move it",
		)
	}, 15_000)

	test("rejects conflicted jj changes with an actionable change ID", async () => {
		if (!Bun.which("jj")) return
		const fixture = await setup("jj")
		await Bun.write(join(fixture.checkout, "README.md"), "left\n")
		await requireCommand(
			["jj", "describe", "-m", "Left change"],
			fixture.checkout,
		)
		await requireCommand(
			["jj", "bookmark", "create", "left", "-r", "@"],
			fixture.checkout,
		)
		await requireCommand(["jj", "new", "main@origin"], fixture.checkout)
		await Bun.write(join(fixture.checkout, "README.md"), "right\n")
		await requireCommand(
			["jj", "describe", "-m", "Right change"],
			fixture.checkout,
		)
		await requireCommand(
			["jj", "bookmark", "create", "right", "-r", "@"],
			fixture.checkout,
		)
		await requireCommand(["jj", "new", "left", "right"], fixture.checkout)
		await requireCommand(
			["jj", "describe", "-m", "Conflicted merge"],
			fixture.checkout,
		)
		const changeId = (
			await requireCommand(
				["jj", "log", "--no-graph", "-r", "@", "-T", "change_id"],
				fixture.checkout,
			)
		).stdout
		expect(
			(
				await requireCommand(
					["jj", "log", "--no-graph", "-r", "@", "-T", "conflict"],
					fixture.checkout,
				)
			).stdout,
		).toBe("true")
		await expect(publish(fixture.taskPath)).rejects.toThrow(
			`Change ${changeId} contains conflicts. Run: jj resolve -r ${changeId}`,
		)
	})
})
