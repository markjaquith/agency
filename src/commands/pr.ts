import { Effect } from "effect"
import { resolve } from "node:path"
import { ContextService } from "../services/ContextService"
import { FileSystemService } from "../services/FileSystemService"

export const pr = (args: readonly string[], cwd: string = process.cwd()) =>
	Effect.gen(function* () {
		const contexts = yield* ContextService
		const fs = yield* FileSystemService
		const invocationCwd = resolve(cwd)
		const context = yield* contexts
			.get({ cwd: invocationCwd, target: ".", compact: true })
			.pipe(Effect.catchAll(() => Effect.succeed(null)))
		const writableCheckout =
			context?.validation.valid && context.workspace?.writable?.materialized
				? context.authority.writable?.checkoutPath
				: null
		const focusedCwd = writableCheckout ?? invocationCwd
		const result = yield* fs.runCommand(["gh", "pr", ...args], {
			cwd: focusedCwd,
			passthrough: true,
		})
		return result.exitCode
	})

export const help = `
Usage: agency pr [args...]

Run gh pr unchanged, focusing the writable repository checkout when invoked
from an Agency execution task or phase.
`
