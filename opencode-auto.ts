#!/usr/bin/env bun
import { Effect } from "effect"
import { FileSystemService } from "./src/services/FileSystemService"
import { prepareOpenCodeLaunch } from "./src/workbase/opencode-launch"
import { execvp } from "./src/utils/exec"

// This is an opt-in wrapper, not a patch to the installed OpenCode binary.
// A PATH shim named `opencode` must set the absolute native executable to avoid
// resolving itself recursively.
const executable = process.env.AGENCY_OPENCODE_EXECUTABLE ?? "opencode"
let argv = [executable, ...process.argv.slice(2)]
if (
	process.env.AGENCY_OPENCODE_AUTO_SUBMIT === "1" &&
	argv.includes("--prompt") &&
	!argv.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg))
) {
	try {
		argv = await Effect.runPromise(
			prepareOpenCodeLaunch(argv, process.cwd(), {}).pipe(
				Effect.provide(FileSystemService.Default),
			),
		)
	} catch (error) {
		console.error(String(error))
		process.exit(1)
	}
}
execvp(executable, argv)
