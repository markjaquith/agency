import { Effect } from "effect"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { FileSystemService } from "./FileSystemService"
import { WorkbaseService } from "./WorkbaseService"
import {
	canUpdateManagedWorkbaseAgents,
	managedWorkbaseAgents,
} from "../workbase/agents-file"
import {
	canUpdateManagedWorkbaseOpencode,
	managedWorkbaseOpencode,
} from "../workbase/opencode-file"
import {
	canUpdateManagedWorkbaseOpencodePlugin,
	managedWorkbaseOpencodePlugin,
} from "../workbase/opencode-plugin-file"
import {
	canUpdateManagedWorkbaseOpencodeTui,
	managedWorkbaseOpencodeTui,
} from "../workbase/opencode-tui-file"
import {
	canUpdateManagedWorkbaseOpencodeTuiPlugin,
	managedWorkbaseOpencodeTuiPlugin,
} from "../workbase/opencode-tui-plugin-file"

type IntegrationFileState = "managed" | "customized" | "missing" | "drifted"

interface IntegrationFileStatus {
	readonly name:
		| "agents"
		| "opencode"
		| "opencode-plugin"
		| "opencode-tui"
		| "opencode-tui-plugin"
	readonly path: string
	readonly state: IntegrationFileState
	readonly diagnostic: string
	readonly remediation: string | null
}

interface IntegrationSyncFile extends IntegrationFileStatus {
	readonly changed: boolean
}

const describe = (
	name: IntegrationFileStatus["name"],
	state: IntegrationFileState,
) => {
	if (name === "opencode") {
		if (state === "managed") {
			return {
				diagnostic:
					"Agency's managed OpenCode launch config is ready to load Agency instructions and provide whole-workbase read access.",
				remediation: null,
			}
		}
		if (state === "customized") {
			return {
				diagnostic:
					"Agency cannot guarantee its instructions or whole-workbase read access from this customized OpenCode config.",
				remediation:
					"Back up and remove the customized file, run 'agency integration sync', then move any retained custom settings to OpenCode's global config.",
			}
		}
		return {
			diagnostic:
				"Agency OpenCode launches cannot load current Agency instructions or whole-workbase access.",
			remediation:
				"Run 'agency integration sync' to install Agency instructions and whole-workbase OpenCode access.",
		}
	}
	if (name === "opencode-plugin") {
		return state === "managed"
			? {
					diagnostic:
						"Agency's managed OpenCode plugin provides whole-workbase access and exposes writable-checkout skills.",
					remediation: null,
				}
			: state === "customized"
				? {
						diagnostic:
							"A user-owned OpenCode checkout-skill plugin is present and was preserved.",
						remediation: null,
					}
				: {
						diagnostic:
							"The managed OpenCode workbase plugin needs synchronization.",
						remediation:
							"Run 'agency integration sync' to provide workbase access and expose writable-checkout skills in OpenCode.",
					}
	}
	if (name === "opencode-tui") {
		return state === "managed"
			? {
					diagnostic:
						"Agency's managed OpenCode TUI config explicitly loads /agency-debug.",
					remediation: null,
				}
			: state === "customized"
				? {
						diagnostic:
							"A user-owned OpenCode TUI config is present and was preserved.",
						remediation:
							"Add './tui/agency-debug.ts' to its plugin list to enable /agency-debug.",
					}
				: {
						diagnostic:
							"The managed OpenCode TUI config needs synchronization.",
						remediation:
							"Run 'agency integration sync' to register /agency-debug.",
					}
	}
	if (name === "opencode-tui-plugin") {
		return state === "managed"
			? {
					diagnostic:
						"Agency's managed OpenCode TUI diagnostic companion is current.",
					remediation: null,
				}
			: state === "customized"
				? {
						diagnostic:
							"A user-owned OpenCode /agency-debug TUI plugin is present and was preserved.",
						remediation: null,
					}
				: {
						diagnostic:
							"The managed OpenCode TUI diagnostic companion needs synchronization.",
						remediation:
							"Run 'agency integration sync' to install /agency-debug.",
					}
	}

	return state === "missing" || state === "drifted"
		? {
				diagnostic: "Managed workbase instructions need synchronization.",
				remediation:
					"Run 'agency integration sync' to restore managed instructions.",
			}
		: {
				diagnostic:
					state === "managed"
						? "Managed workbase instructions are current."
						: "Customized workbase instructions are preserved.",
				remediation: null,
			}
}

const fileStatus = (
	name: IntegrationFileStatus["name"],
	path: string,
	state: IntegrationFileState,
): IntegrationFileStatus => ({ name, path, state, ...describe(name, state) })

const classify = (
	name: IntegrationFileStatus["name"],
	path: string,
	content: string,
	managed: string,
	canUpdate: (content: string) => boolean,
): IntegrationFileStatus =>
	fileStatus(
		name,
		path,
		content === managed
			? "managed"
			: canUpdate(content)
				? "drifted"
				: "customized",
	)

const inspect = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const agentsPath = join(root, ".agency", "AGENTS.md")
		const opencodeDirectory = join(root, ".opencode")
		const opencodePath = join(opencodeDirectory, "opencode.jsonc")
		const opencodeJsonPath = join(opencodeDirectory, "opencode.json")
		const tuiPath = join(opencodeDirectory, "tui.jsonc")
		const tuiJsonPath = join(opencodeDirectory, "tui.json")
		const pluginPath = join(
			opencodeDirectory,
			"plugin",
			"agency-repository-skills.ts",
		)
		const pluralPluginPath = join(
			opencodeDirectory,
			"plugins",
			"agency-repository-skills.ts",
		)
		const tuiPluginPath = join(opencodeDirectory, "tui", "agency-debug.ts")
		const files: IntegrationFileStatus[] = []

		files.push(
			(yield* fs.readSymlinkTarget(agentsPath)) !== null
				? fileStatus("agents", agentsPath, "customized")
				: (yield* fs.exists(agentsPath))
					? classify(
							"agents",
							agentsPath,
							yield* fs.readFile(agentsPath),
							managedWorkbaseAgents,
							canUpdateManagedWorkbaseAgents,
						)
					: fileStatus("agents", agentsPath, "missing"),
		)

		if ((yield* fs.readSymlinkTarget(opencodePath)) !== null) {
			files.push(fileStatus("opencode", opencodePath, "customized"))
		} else if (
			(yield* fs.readSymlinkTarget(opencodeJsonPath)) !== null ||
			(yield* fs.exists(opencodeJsonPath))
		) {
			files.push(fileStatus("opencode", opencodeJsonPath, "customized"))
		} else if (yield* fs.exists(opencodePath)) {
			files.push(
				classify(
					"opencode",
					opencodePath,
					yield* fs.readFile(opencodePath),
					managedWorkbaseOpencode,
					canUpdateManagedWorkbaseOpencode,
				),
			)
		} else {
			files.push(fileStatus("opencode", opencodePath, "missing"))
		}

		if ((yield* fs.readSymlinkTarget(pluginPath)) !== null) {
			files.push(fileStatus("opencode-plugin", pluginPath, "customized"))
		} else if (
			(yield* fs.readSymlinkTarget(pluralPluginPath)) !== null ||
			(yield* fs.exists(pluralPluginPath))
		) {
			files.push(fileStatus("opencode-plugin", pluralPluginPath, "customized"))
		} else if (yield* fs.exists(pluginPath)) {
			files.push(
				classify(
					"opencode-plugin",
					pluginPath,
					yield* fs.readFile(pluginPath),
					managedWorkbaseOpencodePlugin,
					canUpdateManagedWorkbaseOpencodePlugin,
				),
			)
		} else {
			files.push(fileStatus("opencode-plugin", pluginPath, "missing"))
		}

		if ((yield* fs.readSymlinkTarget(tuiPath)) !== null) {
			files.push(fileStatus("opencode-tui", tuiPath, "customized"))
		} else if (
			(yield* fs.readSymlinkTarget(tuiJsonPath)) !== null ||
			(yield* fs.exists(tuiJsonPath))
		) {
			files.push(fileStatus("opencode-tui", tuiJsonPath, "customized"))
		} else if (yield* fs.exists(tuiPath)) {
			files.push(
				classify(
					"opencode-tui",
					tuiPath,
					yield* fs.readFile(tuiPath),
					managedWorkbaseOpencodeTui,
					canUpdateManagedWorkbaseOpencodeTui,
				),
			)
		} else {
			files.push(fileStatus("opencode-tui", tuiPath, "missing"))
		}

		if ((yield* fs.readSymlinkTarget(tuiPluginPath)) !== null) {
			files.push(fileStatus("opencode-tui-plugin", tuiPluginPath, "customized"))
		} else if (yield* fs.exists(tuiPluginPath)) {
			files.push(
				classify(
					"opencode-tui-plugin",
					tuiPluginPath,
					yield* fs.readFile(tuiPluginPath),
					managedWorkbaseOpencodeTuiPlugin,
					canUpdateManagedWorkbaseOpencodeTuiPlugin,
				),
			)
		} else {
			files.push(fileStatus("opencode-tui-plugin", tuiPluginPath, "missing"))
		}

		return files
	})

const canRemoveLegacyAgents = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const path = join(root, "AGENTS.md")
		if (
			(yield* fs.readSymlinkTarget(path)) !== null ||
			!(yield* fs.exists(path))
		)
			return false
		return canUpdateManagedWorkbaseAgents(yield* fs.readFile(path))
	})

const canRemoveLegacyOpencodeCommand = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const path = join(root, ".opencode", "command", "agency.md")
		if (
			(yield* fs.readSymlinkTarget(path)) !== null ||
			!(yield* fs.exists(path))
		)
			return false

		const content = yield* fs.readFile(path)
		const header = /^---\r?\n# agency-managed: sha256=([a-f0-9]{64})\r?\n/
		const match = content.match(header)
		if (!match?.[1]) return false

		const canonical = content.replace(header, "---\n")
		return createHash("sha256").update(canonical).digest("hex") === match[1]
	})

export class IntegrationService extends Effect.Service<IntegrationService>()(
	"IntegrationService",
	{
		sync: () => ({
			status: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const root = yield* workbase.discover(startPath)
					return { root, files: yield* inspect(root) }
				}),

			sync: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const workbase = yield* WorkbaseService
					const root = yield* workbase.discover(startPath)
					const statuses = yield* inspect(root)
					const removeLegacyAgents =
						statuses.some(
							(status) =>
								status.name === "opencode" && status.state !== "customized",
						) && (yield* canRemoveLegacyAgents(root))
					const removeLegacyOpencodeCommand =
						yield* canRemoveLegacyOpencodeCommand(root)
					const files: IntegrationSyncFile[] = []

					for (const status of statuses) {
						const needsWrite =
							status.state === "missing" || status.state === "drifted"
						if (needsWrite) {
							if (status.name === "agents") {
								yield* fs.createDirectory(join(root, ".agency"))
								yield* fs.writeFile(status.path, managedWorkbaseAgents)
							} else if (status.name === "opencode") {
								yield* fs.createDirectory(join(root, ".opencode"))
								yield* fs.writeFile(status.path, managedWorkbaseOpencode)
							} else if (status.name === "opencode-plugin") {
								yield* fs.createDirectory(join(root, ".opencode", "plugin"))
								yield* fs.writeFile(status.path, managedWorkbaseOpencodePlugin)
							} else if (status.name === "opencode-tui") {
								yield* fs.createDirectory(join(root, ".opencode"))
								yield* fs.writeFile(status.path, managedWorkbaseOpencodeTui)
							} else {
								yield* fs.createDirectory(join(root, ".opencode", "tui"))
								yield* fs.writeFile(
									status.path,
									managedWorkbaseOpencodeTuiPlugin,
								)
							}
						}
						files.push({
							...fileStatus(
								status.name,
								status.path,
								needsWrite ? "managed" : status.state,
							),
							changed:
								needsWrite || (status.name === "agents" && removeLegacyAgents),
						})
					}

					if (removeLegacyAgents) yield* fs.deleteFile(join(root, "AGENTS.md"))
					if (removeLegacyOpencodeCommand) {
						yield* fs.deleteFile(
							join(root, ".opencode", "command", "agency.md"),
						)
					}

					return { root, files }
				}),
		}),
	},
) {}
