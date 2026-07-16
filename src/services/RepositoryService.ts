import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { join, resolve } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import { RepositoryAlias } from "../workbase/schemas"

class RepositoryError extends Data.TaggedError("RepositoryError")<{
	readonly message: string
	readonly cause?: unknown
}> {}

interface RepositoryInfo {
	readonly alias: string
	readonly path: string
	readonly kind: "bare" | "repository" | "symlink"
	readonly remote: string | null
	readonly target: string | null
}

const validateAlias = (alias: string) => {
	const result = Schema.decodeUnknownEither(RepositoryAlias)(alias)
	return Either.isLeft(result)
		? Effect.fail(
				new RepositoryError({
					message: `Invalid repository alias '${alias}': ${TreeFormatter.formatErrorSync(result.left)}`,
				}),
			)
		: Effect.succeed(result.right)
}

export class RepositoryService extends Effect.Service<RepositoryService>()(
	"RepositoryService",
	{
		sync: () => ({
			add: (alias: string, remote: string, startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const validAlias = yield* validateAlias(alias)
					const root = yield* workbase.discover(startPath)
					const reposPath = join(root, "repos")
					const destination = join(reposPath, validAlias)

					if (!remote.trim()) {
						return yield* new RepositoryError({
							message: "Repository remote is required",
						})
					}
					if (yield* fs.exists(destination)) {
						return yield* new RepositoryError({
							message: `Repository alias '${validAlias}' already exists`,
						})
					}

					yield* fs.createDirectory(reposPath)
					const result = yield* fs.runCommand(
						["git", "clone", "--bare", remote, destination],
						{ captureOutput: true },
					)
					if (result.exitCode !== 0) {
						yield* fs.deleteDirectory(destination).pipe(Effect.ignore)
						return yield* new RepositoryError({
							message: `Failed to clone repository '${remote}': ${result.stderr.trim()}`,
						})
					}

					return destination
				}),

			link: (
				alias: string,
				target: string,
				startPath: string = process.cwd(),
			) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const validAlias = yield* validateAlias(alias)
					const root = yield* workbase.discover(startPath)
					const reposPath = join(root, "repos")
					const destination = join(reposPath, validAlias)
					const resolvedTarget = resolve(startPath, target)

					if (yield* fs.exists(destination)) {
						return yield* new RepositoryError({
							message: `Repository alias '${validAlias}' already exists`,
						})
					}
					if (!(yield* fs.isDirectory(resolvedTarget))) {
						return yield* new RepositoryError({
							message: `Repository path does not exist: ${resolvedTarget}`,
						})
					}

					const result = yield* fs.runCommand(
						["git", "-C", resolvedTarget, "rev-parse", "--git-dir"],
						{ captureOutput: true },
					)
					if (result.exitCode !== 0) {
						return yield* new RepositoryError({
							message: `Path is not a Git repository: ${resolvedTarget}`,
						})
					}

					yield* fs.createDirectory(reposPath)
					yield* fs.createSymlink(resolvedTarget, destination)
					return destination
				}),

			list: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const root = yield* workbase.discover(startPath)
					const reposPath = join(root, "repos")

					if (!(yield* fs.isDirectory(reposPath))) {
						return [] as RepositoryInfo[]
					}

					const entries = (yield* fs.readDirectory(reposPath))
						.filter((entry) => entry.isDirectory || entry.isSymlink)
						.sort((a, b) => a.name.localeCompare(b.name))
					const repositories: RepositoryInfo[] = []

					for (const entry of entries) {
						const path = join(reposPath, entry.name)
						const target = entry.isSymlink
							? yield* fs.readSymlinkTarget(path)
							: null
						const bareResult = yield* fs.runCommand(
							["git", "-C", path, "rev-parse", "--is-bare-repository"],
							{ captureOutput: true },
						)
						const remoteResult = yield* fs.runCommand(
							["git", "-C", path, "remote", "get-url", "origin"],
							{ captureOutput: true },
						)

						repositories.push({
							alias: entry.name,
							path,
							kind: entry.isSymlink
								? "symlink"
								: bareResult.stdout.trim() === "true"
									? "bare"
									: "repository",
							remote:
								remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : null,
							target,
						})
					}

					return repositories
				}),
		}),
	},
) {}
