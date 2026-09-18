import { createHash } from "node:crypto"

const managedHeaderPattern =
	/^\/\/ agency-managed: sha256=([a-f0-9]{64})\r?\n\r?\n/

const checksum = (content: string) =>
	createHash("sha256").update(content).digest("hex")

const body = `import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin, PluginModule } from "@opencode-ai/plugin/v1"

const workerLaunchPattern = /^Agency worker launch target: ([^.\\s]+)\\./

type AgencyContext = {
  root?: string
  checkout?: string
  documentDirectory?: string
  target?: string
  task?: string
  phase?: string
}

type V2PluginContext = {
  location: { directory: string }
  reference: {
    transform(callback: (references: {
      list(): readonly (readonly [string, unknown])[]
      add(name: string, source: { type: "local"; path: string; description: string }): void
    }) => void): Promise<unknown>
  }
  skill: {
    transform(callback: (skills: {
      source(source: { type: "directory"; path: string }): void
    }) => void): Promise<unknown>
  }
  session: {
    hook(name: "context", handler: (event: { system: Array<{ type: "text"; text: string }> }) => void): Promise<unknown>
  }
}

const contextTarget = (result: Record<string, any>): string | undefined => {
  const target = result.target
  if (target?.kind === "epic") return \`epic:\${target.epicId}\`
  if (target?.kind === "phase") {
    return \`execution-unit:phase/\${target.taskId}/\${target.phaseId}\`
  }
  if (target?.kind === "task") {
    return result.authority?.mode === "execution"
      ? \`execution-unit:task/\${target.taskId}\`
      : \`task:\${target.taskId}\`
  }
}

const workerLaunchTarget = (parts: unknown) => {
  if (!Array.isArray(parts)) return
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\\n")
  return text.match(workerLaunchPattern)?.[1]
}

const discoverWorkbase = (directory: string) => {
  let current = directory
  while (true) {
    if (existsSync(join(current, "agency.json"))) return current
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

const discoverCheckout = (directory: string, root: string | undefined) => {
  if (!root) return
  let current = directory
  while (current.startsWith(root)) {
    for (const name of ["PHASE.md", "TASK.md"]) {
      const document = join(current, name)
      if (!existsSync(document)) continue
      const repo = readFileSync(document, "utf8").match(/^repo:\\s*([^\\s]+)\\s*$/m)?.[1]
      if (!repo) return
      const checkout = join(current, "code", repo.replace(/^['\"]|['\"]$/g, ""))
      return existsSync(checkout) ? checkout : undefined
    }
    if (current === root) return
    current = dirname(current)
  }
}

const checkoutSkillPaths = (checkout: string | undefined) => checkout
  ? [
      join(checkout, ".claude", "skills"),
      join(checkout, ".agents", "skills"),
      join(checkout, ".opencode", "skill"),
      join(checkout, ".opencode", "skills"),
    ].filter(existsSync)
  : []

const implementationInstructions = (
  client: "OpenCode" | "Pi",
  context: AgencyContext | undefined,
  directory: string,
) => {
  if (!context?.checkout) return
  const checkout = resolve(context.checkout)
  const current = resolve(directory)
  const repository = current === checkout || current.startsWith(\`\${checkout}\${sep}\`)
    ? \`\${client} is rooted in Agency's authoritative writable checkout at \${checkout}. Use this directory for source reads, edits, Git status and other Git operations, builds, tests, and formatting.\`
    : \`Agency's authoritative writable checkout is \${checkout}. Before doing implementation work or Git operations, change the working directory to that checkout. Set each tool's working directory to it when supported; otherwise use absolute paths.\`
  const lifecycle = context.documentDirectory
    ? \`Run Agency lifecycle commands from \${context.documentDirectory}; agency context may also be queried from the checkout. Any reference checkouts reported by Agency context are read-only.\`
    : "Any reference checkouts reported by Agency context are read-only."
  return \`\${repository} \${lifecycle}\`
}

const agencyContext = async (
  directory: string,
  useEnvironmentTarget = true,
  requireWorking = false,
): Promise<AgencyContext | undefined> => {
  const task = useEnvironmentTarget ? process.env.AGENCY_TASK_ID : undefined
  const phase = useEnvironmentTarget ? process.env.AGENCY_PHASE_ID : undefined
  const args = task
    ? ["agency", "context", "--task", task, ...(phase ? ["--phase", phase] : []), "--compact", "--json"]
    : ["agency", "context", ".", "--compact", "--json"]
  const child = Bun.spawn(args, {
    cwd: directory,
    env: process.env,
    stdout: "pipe",
    stderr: "ignore",
  })
  const output = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) return
  const envelope = JSON.parse(output)
  if (envelope.ok !== true) return
  const result = envelope.result ?? {}
  const target = contextTarget(result)
  const document = result.target?.path
  const checkout = result.authority?.writable?.checkoutPath
  const status = result.documents?.phase?.data?.status ?? result.documents?.task?.data?.status
  const current = resolve(directory)
  const documentDirectory = document ? dirname(document) : undefined
  const matchesLocation =
    documentDirectory === current ||
    (checkout &&
      (current === resolve(checkout) || current.startsWith(\`\${resolve(checkout)}\${sep}\`)))
  if (
    result.validation?.valid !== true ||
    !target ||
    !document ||
    !matchesLocation ||
    (requireWorking && target.startsWith("execution-unit:") &&
      (!result.authority?.writable?.checkoutPath || status !== "working"))
  ) return
  return {
    root: result.workbase?.root,
    checkout,
    documentDirectory,
    target,
    task: result.target?.taskId,
    phase: result.target?.phaseId,
  }
}

const plugin: Plugin = async ({ directory }) => {
  const workerSessions = new Map<string, AgencyContext>()
  const locationContext = agencyContext(directory, false).catch(() => undefined)

  return {
    config: async (config) => {
      const context = await locationContext
      const root = process.env.AGENCY_WORKBASE ?? context?.root ?? discoverWorkbase(directory)
      const checkout = process.env.AGENCY_WRITABLE_CHECKOUT ?? context?.checkout ?? discoverCheckout(directory, root)

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

      const paths = checkoutSkillPaths(checkout).map((path) => \`\${path}\${sep}.\`)
      if (paths.length === 0) return

      config.skills ??= {}
      config.skills.paths = [...new Set([...(config.skills.paths ?? []), ...paths])]
    },
    "chat.message": async ({ sessionID }, output) => {
      const launchTarget = workerLaunchTarget(output.parts)
      if (!launchTarget) return
      const context = await agencyContext(directory, false, true).catch(() => undefined)
      if (context?.target !== launchTarget) return
      workerSessions.set(sessionID, context)
    },
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (!sessionID) return
      const worker = workerSessions.get(sessionID)
      const context = worker ?? await locationContext
      const implementation = implementationInstructions("OpenCode", context, directory)
      if (!worker?.target && !implementation) return
      output.system.push([
        worker?.target
          ? \`Agency verified this OpenCode session as the active worker for \${worker.target}. Perform the assigned work directly. Do not invoke agency work for this target or launch a replacement worker.\`
          : undefined,
        implementation,
      ].filter(Boolean).join(" "))
    },
    "shell.env": async ({ sessionID }, output) => {
      if (!sessionID) return
      const context = workerSessions.get(sessionID)
      if (!context?.target) return
      output.env.AGENCY_SESSION_ID = sessionID
      output.env.AGENCY_TARGET = context.target
      if (context.root) output.env.AGENCY_WORKBASE = context.root
      if (context.checkout) output.env.AGENCY_WRITABLE_CHECKOUT = context.checkout
      if (context.task) output.env.AGENCY_TASK_ID = context.task
      if (context.phase) output.env.AGENCY_PHASE_ID = context.phase
    },
  }
}

export const AgencyPlugin = plugin

const setup = async (context: V2PluginContext) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const agency = await agencyContext(context.location.directory, false).catch(() => undefined)
  await context.reference.transform((references) => {
    if (references.list().some(([name]) => name === "workbase")) return
    references.add("workbase", {
      type: "local",
      path: root,
      description: "Complete Agency workbase context; write authority still comes only from agency context",
    })
  })

  const paths = checkoutSkillPaths(process.env.AGENCY_WRITABLE_CHECKOUT ?? agency?.checkout)
  if (paths.length > 0) {
    await context.skill.transform((skills) => {
      for (const path of paths) skills.source({ type: "directory", path })
    })
  }
  const implementation = implementationInstructions("OpenCode", agency, context.location.directory)
  if (implementation) {
    await context.session.hook("context", (event) => {
      event.system.push({ type: "text", text: implementation })
    })
  }
}

export default {
  id: "agency",
  setup,
  server: plugin,
} satisfies PluginModule & { setup: (context: V2PluginContext) => Promise<void> }
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
