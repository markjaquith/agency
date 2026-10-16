import { Context, Effect, Layer } from "effect"
import { FileSystemService } from "./FileSystemService"
import { createHerdrRuntimeProvider } from "./HerdrRuntimeProvider"
import type { RuntimeProvider } from "../workbase/runtime"

export class RuntimeService extends Context.Service<RuntimeService>()(
	"RuntimeService",
	{
		make: Effect.sync(() => ({
			/**
			 * Detect the runtime from the inherited Herdr environment or the herdr
			 * binary. No runtime is a normal state and yields null.
			 */
			provider: (
				env: NodeJS.ProcessEnv = process.env,
			): Effect.Effect<RuntimeProvider | null, never, FileSystemService> =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const inherited =
						env.HERDR_ENV === "1" && env.HERDR_BIN_PATH
							? env.HERDR_BIN_PATH
							: undefined
					const binary =
						inherited ??
						(yield* fs
							.runCommand(["which", "herdr"], {
								captureOutput: true,
								timeoutMs: 2_000,
							})
							.pipe(
								Effect.map((result) =>
									result.exitCode === 0 ? result.stdout.trim() || null : null,
								),
								Effect.orElseSucceed(() => null),
							))
					if (!binary) return null
					return createHerdrRuntimeProvider(fs, binary, env)
				}),
		})),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
