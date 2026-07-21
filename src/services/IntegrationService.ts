import { Effect } from "effect"
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

type IntegrationFileState = "managed" | "customized" | "missing" | "drifted"

interface IntegrationFileStatus {
	readonly name: "agents" | "opencode"
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
					const files: IntegrationSyncFile[] = []

					for (const status of statuses) {
						const needsWrite =
							status.state === "missing" || status.state === "drifted"
						if (needsWrite) {
							if (status.name === "agents") {
								yield* fs.createDirectory(join(root, ".agency"))
								yield* fs.writeFile(status.path, managedWorkbaseAgents)
							} else {
								yield* fs.createDirectory(join(root, ".opencode"))
								yield* fs.writeFile(status.path, managedWorkbaseOpencode)
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

					return { root, files }
				}),
		}),
	},
) {}
