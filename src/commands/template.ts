import { Effect } from "effect"
import { use } from "./use"
import { save } from "./save"
import { templateList } from "./template-list"
import { templateDelete } from "./template-delete"
import { templateView } from "./template-view"

export const help = `
Usage: agency template <subcommand> [options]

Subcommands:
  use [template]         Set template for this repository
  save <file|dir> ...    Save files/dirs to configured template
  list                   List all files in configured template
  view <file>            View contents of a file in template
  delete <file> ...      Delete files from configured template

Examples:
  agency template use                    # Interactively select template
  agency template use work               # Set template to 'work'
  agency template save AGENTS.md         # Save specific file to template
  agency template list                   # List files in current template
  agency template view AGENTS.md         # View file from template
  agency template delete AGENTS.md       # Delete file from template

For more information about a subcommand, run:
  agency template <subcommand> --help
`

export const template = (options: {
	subcommand?: string
	args: string[]
	silent?: boolean
	verbose?: boolean
	template?: string
}) =>
	Effect.gen(function* () {
		const {
			subcommand,
			args,
			silent,
			verbose,
			template: templateName,
		} = options

		if (!subcommand) {
			return yield* Effect.fail(
				new Error(
					"Subcommand is required. Available subcommands: use, save, list, view, delete\n\nRun 'agency template --help' for usage information.",
				),
			)
		}

		switch (subcommand) {
			case "use":
				return yield* use({
					template: args[0] || templateName,
					silent,
					verbose,
				})

			case "save":
				return yield* save({
					files: args,
					silent,
					verbose,
				})

			case "list":
				return yield* templateList({
					silent,
					verbose,
				})

			case "view":
				return yield* templateView({
					file: args[0],
					silent,
					verbose,
				})

			case "delete":
				return yield* templateDelete({
					files: args,
					silent,
					verbose,
				})

			default:
				return yield* Effect.fail(
					new Error(
						`Unknown template subcommand '${subcommand}'. Available: use, save, list, view, delete`,
					),
				)
		}
	})
