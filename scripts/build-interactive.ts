import solidPlugin from "@opentui/solid/bun-plugin"
import { join } from "node:path"
import { rm } from "node:fs/promises"

// OpenTUI's runtime JSX transform excludes node_modules. Publish compiled
// reactive JSX so an installed CLI behaves like the source checkout.
const root = join(import.meta.dir, "..")
if (process.argv.includes("--clean")) {
	// Do not let the generated sibling shadow source edits after packing.
	await rm(join(root, "src/utils/interactive.js"), { force: true })
	process.exit(0)
}
const result = await Bun.build({
	entrypoints: [join(root, "src/utils/interactive.tsx")],
	outdir: join(root, "src/utils"),
	target: "bun",
	plugins: [solidPlugin],
	external: ["*"],
})
if (!result.success)
	throw new AggregateError(result.logs, "Failed to build interactive UI")
