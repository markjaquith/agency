import { Effect } from "effect"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
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

const managedHeaderPattern =
	/^\/\/ agency-managed: sha256=([a-f0-9]{64})\r?\n\r?\n/

const canRemoveLegacyPiExtension = (content: string) => {
	const match = content.match(managedHeaderPattern)
	if (!match?.[1]) return false
	return (
		createHash("sha256")
			.update(content.slice(match[0].length))
			.digest("hex") === match[1]
	)
}

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
		const legacyPluginPath = join(
			opencodeDirectory,
			"plugin",
			"agency-repository-skills.ts",
		)
		const pluginPath = join(
			opencodeDirectory,
			"plugins",
			"agency-repository-skills.ts",
		)
		const tuiPluginPath = join(opencodeDirectory, "tui", "agency-debug.ts")
		const [
			agents,
			opencode,
			opencodeJson,
			plugin,
			legacyPlugin,
			tui,
			tuiJson,
			tuiPlugin,
		] = yield* Effect.all(
			[
				fs.inspectFile(agentsPath),
				fs.inspectFile(opencodePath),
				fs.inspectFile(opencodeJsonPath),
				fs.inspectFile(pluginPath),
				fs.inspectFile(legacyPluginPath),
				fs.inspectFile(tuiPath),
				fs.inspectFile(tuiJsonPath),
				fs.inspectFile(tuiPluginPath),
			] as const,
			{ concurrency: 8 },
		)
		const files: IntegrationFileStatus[] = []

		files.push(
			agents.kind === "symlink"
				? fileStatus("agents", agentsPath, "customized")
				: agents.kind === "file"
					? classify(
							"agents",
							agentsPath,
							agents.content,
							managedWorkbaseAgents,
							canUpdateManagedWorkbaseAgents,
						)
					: fileStatus("agents", agentsPath, "missing"),
		)

		if (opencode.kind === "symlink") {
			files.push(fileStatus("opencode", opencodePath, "customized"))
		} else if (opencodeJson.kind !== "missing") {
			files.push(fileStatus("opencode", opencodeJsonPath, "customized"))
		} else if (opencode.kind === "file") {
			files.push(
				classify(
					"opencode",
					opencodePath,
					opencode.content,
					managedWorkbaseOpencode,
					canUpdateManagedWorkbaseOpencode,
				),
			)
		} else {
			files.push(fileStatus("opencode", opencodePath, "missing"))
		}

		if (plugin.kind === "symlink") {
			files.push(fileStatus("opencode-plugin", pluginPath, "customized"))
		} else if (plugin.kind === "file") {
			files.push(
				classify(
					"opencode-plugin",
					pluginPath,
					plugin.content,
					managedWorkbaseOpencodePlugin,
					canUpdateManagedWorkbaseOpencodePlugin,
				),
			)
		} else if (legacyPlugin.kind !== "missing") {
			const legacyContent =
				legacyPlugin.kind === "file" ? legacyPlugin.content : null
			files.push(
				legacyContent !== null &&
					canUpdateManagedWorkbaseOpencodePlugin(legacyContent)
					? fileStatus("opencode-plugin", pluginPath, "missing")
					: fileStatus("opencode-plugin", legacyPluginPath, "customized"),
			)
		} else {
			files.push(fileStatus("opencode-plugin", pluginPath, "missing"))
		}

		if (tui.kind === "symlink") {
			files.push(fileStatus("opencode-tui", tuiPath, "customized"))
		} else if (tuiJson.kind !== "missing") {
			files.push(fileStatus("opencode-tui", tuiJsonPath, "customized"))
		} else if (tui.kind === "file") {
			files.push(
				classify(
					"opencode-tui",
					tuiPath,
					tui.content,
					managedWorkbaseOpencodeTui,
					canUpdateManagedWorkbaseOpencodeTui,
				),
			)
		} else {
			files.push(fileStatus("opencode-tui", tuiPath, "missing"))
		}

		if (tuiPlugin.kind === "symlink") {
			files.push(fileStatus("opencode-tui-plugin", tuiPluginPath, "customized"))
		} else if (tuiPlugin.kind === "file") {
			files.push(
				classify(
					"opencode-tui-plugin",
					tuiPluginPath,
					tuiPlugin.content,
					managedWorkbaseOpencodeTuiPlugin,
					canUpdateManagedWorkbaseOpencodeTuiPlugin,
				),
			)
		} else {
			files.push(fileStatus("opencode-tui-plugin", tuiPluginPath, "missing"))
		}

		return { files, legacyPlugin }
	})

const canRemoveLegacyAgents = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const path = join(root, "AGENTS.md")
		const file = yield* fs.inspectFile(path)
		return file.kind === "file" && canUpdateManagedWorkbaseAgents(file.content)
	})

const canRemoveLegacyOpencodeCommand = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const path = join(root, ".opencode", "command", "agency.md")
		const file = yield* fs.inspectFile(path)
		if (file.kind !== "file") return false

		const content = file.content
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
					return { root, files: (yield* inspect(root)).files }
				}),

			statusRoot: (root: string) =>
				inspect(root).pipe(Effect.map(({ files }) => ({ root, files }))),

			sync: (startPath: string = process.cwd()) =>
				Effect.gen(function* () {
					const workbase = yield* WorkbaseService
					const root = yield* workbase.discover(startPath)
					const service = yield* IntegrationService
					return yield* service.syncRoot(root)
				}),

			syncRoot: (root: string) =>
				Effect.gen(function* () {
					const fs = yield* FileSystemService
					const { files: statuses, legacyPlugin } = yield* inspect(root)
					const legacyPiExtension = join(
						root,
						".pi",
						"extensions",
						"agency-workbase.ts",
					)
					const canRemoveAgents = statuses.some(
						(status) =>
							status.name === "opencode" && status.state !== "customized",
					)
					const [
						removeLegacyAgents,
						removeLegacyOpencodeCommand,
						removeLegacyPiExtension,
					] = yield* Effect.all(
						[
							canRemoveAgents
								? canRemoveLegacyAgents(root)
								: Effect.succeed(false),
							canRemoveLegacyOpencodeCommand(root),
							fs
								.inspectFile(legacyPiExtension)
								.pipe(
									Effect.map(
										(file) =>
											file.kind === "file" &&
											canRemoveLegacyPiExtension(file.content),
									),
								),
						] as const,
						{ concurrency: 3 },
					)
					const removeLegacyOpencodePlugin =
						legacyPlugin.kind === "file" &&
						canUpdateManagedWorkbaseOpencodePlugin(legacyPlugin.content)
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
								yield* fs.createDirectory(join(root, ".opencode", "plugins"))
								yield* fs.writeFile(status.path, managedWorkbaseOpencodePlugin)
							} else if (status.name === "opencode-tui") {
								yield* fs.createDirectory(join(root, ".opencode"))
								yield* fs.writeFile(status.path, managedWorkbaseOpencodeTui)
							} else if (status.name === "opencode-tui-plugin") {
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
								needsWrite ||
								(status.name === "agents" && removeLegacyAgents) ||
								(status.name === "opencode-plugin" &&
									removeLegacyOpencodePlugin),
						})
					}

					if (removeLegacyAgents) yield* fs.deleteFile(join(root, "AGENTS.md"))
					if (removeLegacyOpencodePlugin) {
						yield* fs.deleteFile(
							join(root, ".opencode", "plugin", "agency-repository-skills.ts"),
						)
					}
					if (removeLegacyOpencodeCommand) {
						yield* fs.deleteFile(
							join(root, ".opencode", "command", "agency.md"),
						)
					}
					if (removeLegacyPiExtension) {
						yield* fs.deleteFile(legacyPiExtension)
						yield* fs.deleteDirectoryIfEmpty(dirname(legacyPiExtension))
						yield* fs.deleteDirectoryIfEmpty(
							dirname(dirname(legacyPiExtension)),
						)
					}

					return { root, files }
				}),
		}),
	},
) {}
