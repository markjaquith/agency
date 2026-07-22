import { createHash } from "node:crypto"

const managedHeaderPattern =
	/^\/\/ agency-managed: sha256=([a-f0-9]{64})\r?\n\r?\n/

const checksum = (content: string) =>
	createHash("sha256").update(content).digest("hex")

const body = `import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const serverMarker = /[\\\\/]\\.$/

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
          const paths = api.state.config.skills?.paths
          const serverInitialized = paths?.some(
            (path) => typeof path === "string" && serverMarker.test(path),
          )
          const message = serverInitialized
            ? "TUI companion: initialized. Server plugin: initialized; checkout skills registered."
            : api.state.ready
              ? "TUI companion: initialized. Server plugin: indeterminate; no checkout skill marker is present."
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
