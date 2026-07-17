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
}

interface IntegrationSyncFile extends IntegrationFileStatus {
	readonly changed: boolean
}

const classify = (
	name: IntegrationFileStatus["name"],
	path: string,
	content: string,
	managed: string,
	canUpdate: (content: string) => boolean,
): IntegrationFileStatus => ({
	name,
	path,
	state:
		content === managed
			? "managed"
			: canUpdate(content)
				? "drifted"
				: "customized",
})

const inspect = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystemService
		const agentsPath = join(root, "AGENTS.md")
		const opencodeDirectory = join(root, ".opencode")
		const opencodePath = join(opencodeDirectory, "opencode.jsonc")
		const opencodeJsonPath = join(opencodeDirectory, "opencode.json")
		const files: IntegrationFileStatus[] = []

		files.push(
			(yield* fs.readSymlinkTarget(agentsPath)) !== null
				? { name: "agents", path: agentsPath, state: "customized" }
				: (yield* fs.exists(agentsPath))
					? classify(
							"agents",
							agentsPath,
							yield* fs.readFile(agentsPath),
							managedWorkbaseAgents,
							canUpdateManagedWorkbaseAgents,
						)
					: { name: "agents", path: agentsPath, state: "missing" },
		)

		if ((yield* fs.readSymlinkTarget(opencodePath)) !== null) {
			files.push({
				name: "opencode",
				path: opencodePath,
				state: "customized",
			})
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
		} else if (yield* fs.exists(opencodeJsonPath)) {
			files.push({
				name: "opencode",
				path: opencodeJsonPath,
				state: "customized",
			})
		} else {
			files.push({ name: "opencode", path: opencodePath, state: "missing" })
		}

		return files
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
					const files: IntegrationSyncFile[] = []

					for (const status of statuses) {
						const changed =
							status.state === "missing" || status.state === "drifted"
						if (changed) {
							if (status.name === "agents") {
								yield* fs.writeFile(status.path, managedWorkbaseAgents)
							} else {
								yield* fs.createDirectory(join(root, ".opencode"))
								yield* fs.writeFile(status.path, managedWorkbaseOpencode)
							}
						}
						files.push({
							...status,
							state: changed ? "managed" : status.state,
							changed,
						})
					}

					return { root, files }
				}),
		}),
	},
) {}
