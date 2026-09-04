import { Data } from "effect"

export const documentRevision = (content: string) =>
	new Bun.CryptoHasher("sha256").update(content).digest("hex")

export class RevisionConflictError extends Data.TaggedError(
	"RevisionConflictError",
)<{
	readonly message: string
	readonly path: string
	readonly target?: string
	readonly expectedRevision: string
	readonly currentRevision: string
}> {}
