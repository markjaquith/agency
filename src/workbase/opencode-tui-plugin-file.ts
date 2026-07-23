import { createHash } from "node:crypto"

const managedHeaderPattern =
	/^\/\/ agency-managed: sha256=([a-f0-9]{64})\r?\n\r?\n/

const checksum = (content: string) =>
	createHash("sha256").update(content).digest("hex")

const body = `import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const serverMarker = /[\\\\/]\\.$/

const findWorkbase = (start: string) => {
  let directory = start
  while (true) {
    if (existsSync(join(directory, "agency.json"))) return directory
    const parent = dirname(directory)
    if (parent === directory) return
    directory = parent
  }
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "agency.debug",
        title: "Agency integration diagnostic",
        desc: "Check Agency's OpenCode TUI and server plugin initialization",
        category: "Agency",
        namespace: "palette",
        slashName: "agency-debug",
        run() {
          const config = api.state.config
          const checkoutSkillsRegistered = config.skills?.paths?.some(
            (path) => typeof path === "string" && serverMarker.test(path),
          )
          const reference = config.references?.workbase
          const managedReference =
            typeof reference === "object" &&
            reference.path === ".." &&
            reference.description ===
              "Complete Agency workbase context; write authority still comes only from agency context"
          const workbase = managedReference
            ? findWorkbase(api.state.path.directory)
            : undefined
          const external =
            typeof config.permission === "object"
              ? config.permission.external_directory
              : undefined
          const workbaseAccessRegistered =
            workbase !== undefined &&
            typeof external === "object" &&
            external[join(workbase, "*")] === "allow"
          const serverInitialized =
            checkoutSkillsRegistered || workbaseAccessRegistered
          const message = serverInitialized
            ? checkoutSkillsRegistered
              ? "TUI companion: initialized. Server plugin: initialized; checkout skills registered."
              : "TUI companion: initialized. Server plugin: initialized; workbase access registered."
            : api.state.ready
              ? "TUI companion: initialized. Server plugin: indeterminate; no Agency config marker is present."
              : "TUI companion: initialized. Server plugin: indeterminate; server state is not ready."

          api.ui.toast({
            variant: serverInitialized ? "success" : "warning",
            title: "Agency integration",
            message,
            duration: 5000,
          })
        },
      },
    ],
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "agency.debug",
  tui,
}

export default plugin
`

const renderManagedWorkbaseOpencodeTuiPlugin = (content: string) =>
	`// agency-managed: sha256=${checksum(content)}\n\n${content}`

export const managedWorkbaseOpencodeTuiPlugin =
	renderManagedWorkbaseOpencodeTuiPlugin(body)

export const canUpdateManagedWorkbaseOpencodeTuiPlugin = (content: string) => {
	const match = content.match(managedHeaderPattern)
	if (!match?.[1]) return false

	return checksum(content.slice(match[0].length)) === match[1]
}
