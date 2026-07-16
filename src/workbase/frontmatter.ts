import { Data, Effect } from "effect"
import { parseDocument, stringify, visit } from "yaml"

class FrontmatterParseError extends Data.TaggedError("FrontmatterParseError")<{
	readonly path: string
	readonly message: string
	readonly cause?: unknown
}> {}

interface ParsedFrontmatter {
	readonly data: unknown
	readonly body: string
}

export const parseFrontmatter = (content: string, path: string) =>
	Effect.try({
		try: (): ParsedFrontmatter => {
			const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
			if (!match) {
				throw new Error("Markdown file must begin with YAML frontmatter")
			}

			const document = parseDocument(match[1]!, {
				customTags: [],
				merge: false,
				schema: "core",
				strict: true,
				uniqueKeys: true,
				version: "1.2",
			})

			const parseMessages = [...document.errors, ...document.warnings]
			if (parseMessages.length > 0) {
				throw new Error(parseMessages.map((error) => error.message).join("; "))
			}

			let unsupportedFeature: string | null = null
			visit(document, {
				Alias: () => {
					unsupportedFeature = "YAML aliases are not supported"
				},
				Node: (_key, node) => {
					if (node.anchor) {
						unsupportedFeature = "YAML anchors are not supported"
					} else if (node.tag && !node.tag.startsWith("tag:yaml.org,2002:")) {
						unsupportedFeature = "Custom YAML tags are not supported"
					}
				},
			})

			if (unsupportedFeature) {
				throw new Error(unsupportedFeature)
			}

			const data = document.toJS({ maxAliasCount: 0 })
			if (data === null || typeof data !== "object" || Array.isArray(data)) {
				throw new Error("YAML frontmatter must be a mapping")
			}

			return {
				data,
				body: content.slice(match[0].length),
			}
		},
		catch: (cause) =>
			new FrontmatterParseError({
				path,
				message:
					cause instanceof Error
						? cause.message
						: "Failed to parse frontmatter",
				cause,
			}),
	})

export const formatMarkdownDocument = (data: object, body: string) =>
	`---\n${stringify(data, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`
