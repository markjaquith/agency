import { Schema, TreeFormatter } from "@effect/schema"
import { Data, Effect, Either } from "effect"
import { join } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import {
	EpicFrontmatter,
	EntityId,
	type RepositoryReference,
} from "../workbase/schemas"
import {
	formatMarkdownDocument,
	parseFrontmatter,
} from "../workbase/frontmatter"
import { documentRevision } from "../workbase/document-revision"
import { archivedEpicDirectory } from "../workbase/archive"

class EpicError extends Data.TaggedError("EpicError")<{
	readonly message: string
}> {}

export interface EpicRecord {
	readonly id: string
	readonly path: string
	readonly content: string
	readonly revision: string
	readonly data: Schema.Schema.Type<typeof EpicFrontmatter>
}

const decodeEpic = (input: unknown) => {
	const result = Schema.decodeUnknownEither(EpicFrontmatter, {
		errors: "all",
		onExcessProperty: "error",
	})(input)
	return Either.isLeft(result)
		? Effect.fail(
				new EpicError({ message: TreeFormatter.formatErrorSync(result.left) }),
			)
		: Effect.succeed(result.right)
}

const decodeId = (id: string) => {
	const result = Schema.decodeUnknownEither(EntityId)(id)
	return Either.isLeft(result)
		? Effect.fail(new EpicError({ message: `Invalid epic ID '${id}'` }))
		: Effect.succeed(result.right)
}

export class EpicService extends Effect.Service<EpicService>()("EpicService", {
	sync: () => ({
		create: (
			id: string,
			ticketUrl: string,
			repos: readonly RepositoryReference[],
			startPath: string = process.cwd(),
			description?: string,
		) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const workbase = yield* WorkbaseService
				const root = yield* workbase.discover(startPath)
				const validId = yield* decodeId(id)
				const data = yield* decodeEpic({
					ticketUrl,
					...(description !== undefined ? { description } : {}),
					repos,
					tasks: [],
				})
				const directory = join(root, "epics", validId)
				const path = join(directory, "EPIC.md")

				if (yield* fs.exists(directory)) {
					return yield* new EpicError({
						message: `Epic '${validId}' already exists`,
					})
				}
				if (yield* fs.exists(archivedEpicDirectory(root, validId))) {
					return yield* new EpicError({
						message: `Epic '${validId}' is archived; restore it before reusing this ID`,
					})
				}

				for (const { repo: alias } of data.repos) {
					if (!(yield* workbase.hasRepositoryAlias(alias, root))) {
						return yield* new EpicError({
							message: `Unknown repository alias '${alias}'`,
						})
					}
				}

				yield* fs.createDirectory(directory)
				const title = validId
					.split("-")
					.map((part) => part[0]?.toUpperCase() + part.slice(1))
					.join(" ")
				const content = formatMarkdownDocument(
					data,
					`# ${title}\n\nDescribe the epic outcome.`,
				)
				yield* fs.writeFile(path, content)
				return {
					id: validId,
					path,
					content,
					revision: documentRevision(content),
					data,
				} satisfies EpicRecord
			}),

		list: (startPath: string = process.cwd()) =>
			Effect.gen(function* () {
				const fs = yield* FileSystemService
				const workbase = yield* WorkbaseService
				const root = yield* workbase.discover(startPath)
				const directory = join(root, "epics")
				if (!(yield* fs.isDirectory(directory))) {
					return [] as EpicRecord[]
				}

				const entries = (yield* fs.readDirectory(directory))
					.filter((entry) => entry.isDirectory)
					.sort((a, b) => a.name.localeCompare(b.name))
				const records: EpicRecord[] = []
				for (const entry of entries) {
					const path = join(directory, entry.name, "EPIC.md")
					if (!(yield* fs.exists(path))) continue
					const content = yield* fs.readFile(path)
					const parsed = yield* parseFrontmatter(content, path)
					const data = yield* decodeEpic(parsed.data)
					records.push({
						id: entry.name,
						path,
						content,
						revision: documentRevision(content),
						data,
					})
				}
				return records
			}),

		show: (id: string, startPath: string = process.cwd()) =>
			Effect.gen(function* () {
				const service = yield* EpicService
				const validId = yield* decodeId(id)
				const records = yield* service.list(startPath)
				const record = records.find((epic) => epic.id === validId)
				if (!record) {
					return yield* new EpicError({
						message: `Epic '${validId}' does not exist`,
					})
				}
				return record
			}),
	}),
}) {}
