import solidPlugin from "@opentui/solid/bun-plugin"
import { join } from "node:path"
import { rm } from "node:fs/promises"

// OpenTUI's runtime JSX transform excludes node_modules. Publish compiled
// reactive JSX so an installed CLI behaves like the source checkout.
const root = join(import.meta.dir, "..")
const views = ["interactive", "supervise-tab"]
if (process.argv.includes("--clean")) {
	// Do not let the generated siblings shadow source edits after packing.
	for (const view of views)
		await rm(join(root, `src/utils/${view}.js`), { force: true })
	process.exit(0)
}
const result = await Bun.build({
	entrypoints: views.map((view) => join(root, `src/utils/${view}.tsx`)),
	outdir: join(root, "src/utils"),
	target: "bun",
	plugins: [solidPlugin],
	external: ["*"],
})
if (!result.success)
	throw new AggregateError(result.logs, "Failed to build interactive UI")
