#!/usr/bin/env bun

const args = Bun.argv.slice(2)
const fastVcsStatus =
	args[0] === "vcs" &&
	args[1] === "status" &&
	(args.length === 2 || (args.length === 3 && args[2] === "--json"))

if (fastVcsStatus) {
	try {
		const { runVcsStatusFast } = await import("./src/vcs-status-fast")
		if (!(await runVcsStatusFast(args[2] === "--json")))
			await import("./cli-main")
	} catch {
		await import("./cli-main")
	}
} else {
	await import("./cli-main")
}
