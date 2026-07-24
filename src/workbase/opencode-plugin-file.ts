import { createHash } from "node:crypto"

const managedHeaderPattern =
	/^\/\/ agency-managed: sha256=([a-f0-9]{64})\r?\n\r?\n/

const checksum = (content: string) =>
	createHash("sha256").update(content).digest("hex")

const body = `import { existsSync } from "node:fs"
import { join, sep } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

const agencyContext = async (directory: string) => {
  const task = process.env.AGENCY_TASK_ID
  const phase = process.env.AGENCY_PHASE_ID
  const args = task
    ? ["agency", "context", "--task", task, ...(phase ? ["--phase", phase] : []), "--compact", "--json"]
    : ["agency", "context", ".", "--compact", "--json"]
  const child = Bun.spawn(args, { cwd: directory, stdout: "pipe", stderr: "ignore" })
  const output = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) return
  const envelope = JSON.parse(output)
  if (envelope.ok !== true) return
  return {
    root: envelope.result?.workbase?.root as string | undefined,
    checkout: envelope.result?.authority?.writable?.checkoutPath as string | undefined,
  }
}

const plugin: Plugin = async ({ directory }) => ({
  config: async (config) => {
    const context = await agencyContext(directory).catch(() => undefined)
    const root = process.env.AGENCY_WORKBASE ?? context?.root
    const checkout = process.env.AGENCY_WRITABLE_CHECKOUT ?? context?.checkout

    const reference = config.references?.workbase
    if (
      root &&
      typeof reference === "object" &&
      reference.path === ".." &&
      reference.description ===
        "Complete Agency workbase context; write authority still comes only from agency context" &&
      typeof config.permission !== "string"
    ) {
      config.permission ??= {}
      const external = config.permission.external_directory
      if (external === undefined) {
        config.permission.external_directory = { [join(root, "*")]: "allow" }
      } else if (typeof external === "object") {
        config.permission.external_directory = {
          [join(root, "*")]: "allow",
          ...external,
        }
      }
    }

    if (!checkout) return

    const paths = [
      join(checkout, ".claude", "skills"),
      join(checkout, ".agents", "skills"),
      join(checkout, ".opencode", "skill"),
      join(checkout, ".opencode", "skills"),
    ].filter(existsSync).map((path) => \`\${path}\${sep}.\`)
    if (paths.length === 0) return

    config.skills ??= {}
    config.skills.paths = [...new Set([...(config.skills.paths ?? []), ...paths])]
  },
})

export default plugin
`

const renderManagedWorkbaseOpencodePlugin = (content: string) =>
	`// agency-managed: sha256=${checksum(content)}\n\n${content}`

export const managedWorkbaseOpencodePlugin =
	renderManagedWorkbaseOpencodePlugin(body)

export const canUpdateManagedWorkbaseOpencodePlugin = (content: string) => {
	const match = content.match(managedHeaderPattern)
	if (!match?.[1]) return false

	return checksum(content.slice(match[0].length)) === match[1]
}
