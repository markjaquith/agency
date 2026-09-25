import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// Network-backed release smoke test, intentionally outside the default test suite.
const root = join(import.meta.dir, "..")
const sandbox = await mkdtemp(join(tmpdir(), "agency-global-install-"))

async function run(command: string[], cwd: string, env = process.env) {
	const child = Bun.spawn(command, {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60_000,
	})
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	])
	assert.equal(code, 0, `${command.join(" ")}\n${stdout}\n${stderr}`)
	return stdout + stderr
}

async function manifest(name: string, from: string) {
	return Bun.file(Bun.resolveSync(`${name}/package.json`, from)).json()
}

try {
	const tarball = join(sandbox, "agency.tgz")
	await run(
		[process.execPath, "pm", "pack", "--filename", tarball, "--quiet"],
		root,
	)
	const files = await run(["tar", "-tzf", tarball], sandbox)
	for (const path of [
		"cli.ts",
		"src/protocol.ts",
		"scripts/install-pi-extension.ts",
	]) {
		assert(
			files.split("\n").includes(`package/${path}`),
			`Missing packed ${path}`,
		)
	}
	assert(
		!/\.test\.tsx?$|package\/bun\.lock$/m.test(files),
		"Packed tests or lockfile",
	)

	// Simulate installing on a platform whose native binary was not on the packing host.
	const unpacked = join(sandbox, "unpacked")
	await mkdir(unpacked)
	await run(["tar", "-xzf", tarball, "-C", unpacked], sandbox)
	const packedManifest = await Bun.file(
		join(unpacked, "package/package.json"),
	).json()
	const coreManifest = await manifest("@opentui/core", root)
	assert.deepEqual(
		packedManifest.optionalDependencies,
		coreManifest.optionalDependencies,
	)
	for (const name of Object.keys(coreManifest.optionalDependencies)) {
		await rm(join(unpacked, "package/node_modules", name), {
			recursive: true,
			force: true,
		})
	}
	const portableTarball = join(sandbox, "agency-without-host-binary.tgz")
	await run(["tar", "-czf", portableTarball, "package"], unpacked)

	for (const mode of ["clean", "existing-globals", "missing-host-binary"]) {
		const seeded = mode !== "clean"
		const prefix = join(sandbox, mode)
		const home = join(prefix, "home")
		const global = join(prefix, "global")
		const bin = join(prefix, "bin")
		await Promise.all(
			[home, global, bin].map((path) => mkdir(path, { recursive: true })),
		)
		const env = {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			BUN_INSTALL: prefix,
			BUN_INSTALL_GLOBAL_DIR: global,
			BUN_INSTALL_BIN: bin,
			BUN_INSTALL_CACHE_DIR: join(prefix, "cache"),
		}
		if (seeded) {
			await run(
				[
					process.execPath,
					"i",
					"-g",
					"web-tree-sitter@0.26.10",
					"typescript@7.0.2",
				],
				home,
				env,
			)
		}
		const artifact = mode === "missing-host-binary" ? portableTarball : tarball
		const output = await run([process.execPath, "i", "-g", artifact], home, env)
		assert(!/incorrect peer dependency/i.test(output), output)
		const installed = join(global, "node_modules", "@markjaquith", "agency")
		const core = dirname(
			Bun.resolveSync("@opentui/core/package.json", installed),
		)
		const ffi = dirname(Bun.resolveSync("bun-ffi-structs/package.json", core))
		const treeSitter = await manifest("web-tree-sitter", core)
		const typescript = await manifest("typescript", ffi)
		assert.equal(treeSitter.version, "0.25.10")
		assert.match(typescript.version, /^5\./)
		if (seeded) {
			assert.equal(
				(await manifest("web-tree-sitter", global)).version,
				"0.26.10",
			)
			assert.equal((await manifest("typescript", global)).version, "7.0.2")
		}
		assert.match(
			await run([join(bin, "agency"), "--help"], home, env),
			/Usage: agency/,
		)
		await run(
			[
				process.execPath,
				"--eval",
				`const { createTestRenderer } = await import(${JSON.stringify(Bun.resolveSync("@opentui/core/testing", installed))});
				const { renderer, renderOnce } = await createTestRenderer({width: 20, height: 5});
				await renderOnce();
				renderer.destroy();
				process.exit(0);`,
			],
			home,
			env,
		)
		// Bun may block dependency lifecycle scripts; exercise the shipped hook explicitly.
		await run(
			[process.execPath, join(installed, "scripts/install-pi-extension.ts")],
			home,
			env,
		)
		assert(
			await Bun.file(join(home, ".pi/agent/extensions/agency.ts")).exists(),
		)
		console.log(
			`${mode}: no peer warnings; web-tree-sitter ${treeSitter.version}, TypeScript ${typescript.version}; CLI, native renderer and packaged hook passed`,
		)
	}
} finally {
	await rm(sandbox, { recursive: true, force: true })
}
