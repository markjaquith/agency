import { expect, test } from "bun:test"
import { resolve } from "node:path"

test("native replacement receives Bun environment additions, updates and deletions", async () => {
	const source = `
		import { execvp } from ${JSON.stringify(resolve(import.meta.dir, "exec.ts"))};
		process.env.AGENCY_EXEC_ADDED = "new identity";
		process.env.AGENCY_EXEC_CHANGED = "new value";
		delete process.env.AGENCY_EXEC_REMOVED;
		execvp("sh", ["sh", "-c", 'printf "%s|%s|%s" "$AGENCY_EXEC_ADDED" "$AGENCY_EXEC_CHANGED" "\${AGENCY_EXEC_REMOVED-unset}"']);
	`
	const child = Bun.spawn([process.execPath, "-e", source], {
		env: {
			...process.env,
			AGENCY_EXEC_CHANGED: "old value",
			AGENCY_EXEC_REMOVED: "remove me",
		},
		stdout: "pipe",
		stderr: "pipe",
	})
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	])
	expect(stderr).toBe("")
	expect(exit).toBe(0)
	expect(stdout).toBe("new identity|new value|unset")
})
