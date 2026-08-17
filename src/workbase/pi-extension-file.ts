import { createHash } from "node:crypto"

const managedHeaderPattern =
	/^\/\/ agency-managed: sha256=([a-f0-9]{64})\r?\n\r?\n/

const checksum = (content: string) =>
	createHash("sha256").update(content).digest("hex")

const body = `import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent"

type AgencyContext = {
  root?: string
  checkout?: string
  target?: string
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

const agencyContext = async (
  pi: ExtensionAPI,
  directory: string,
): Promise<AgencyContext | undefined> => {
  const task = process.env.AGENCY_TASK_ID
  const phase = process.env.AGENCY_PHASE_ID
  const args = task
    ? ["context", "--task", task, ...(phase ? ["--phase", phase] : []), "--compact", "--json"]
    : ["context", ".", "--compact", "--json"]
  const command = await pi.exec("agency", args, { timeout: 5000 })
  if (command.code !== 0) return
  const envelope = JSON.parse(command.stdout)
  if (envelope.ok !== true) return
  const result = envelope.result ?? {}
  const target = contextTarget(result)
  const document = result.target?.path
  const status = result.documents?.phase?.data?.status ?? result.documents?.task?.data?.status
  if (
    result.validation?.valid !== true ||
    !target ||
    !document ||
    dirname(document) !== resolve(directory) ||
    (target.startsWith("execution-unit:") &&
      (!result.authority?.writable?.checkoutPath || status !== "working"))
  ) return
  return {
    root: result.workbase?.root,
    checkout: result.authority?.writable?.checkoutPath,
    target,
  }
}

const extension = (pi: ExtensionAPI) => {
  const contexts = new Map<string, Promise<AgencyContext | undefined>>()
  const runtimeContext = (directory: string) => {
    let context = contexts.get(directory)
    if (!context) {
      context = agencyContext(pi, directory).catch(() => undefined)
      contexts.set(directory, context)
    }
    return context
  }

  pi.on("resources_discover", async (event) => {
    const context = await runtimeContext(event.cwd)
    const root = process.env.AGENCY_WORKBASE ?? context?.root ?? discoverWorkbase(event.cwd)
    const checkout = process.env.AGENCY_WRITABLE_CHECKOUT ?? context?.checkout ?? discoverCheckout(event.cwd, root)
    if (!checkout) return

    const skillPaths = [
      join(checkout, ".claude", "skills"),
      join(checkout, ".agents", "skills"),
      join(checkout, ".opencode", "skill"),
      join(checkout, ".opencode", "skills"),
      join(checkout, CONFIG_DIR_NAME, "skills"),
    ].filter(existsSync)
    if (skillPaths.length === 0) return
    return { skillPaths: [...new Set(skillPaths)] }
  })

  pi.on("before_agent_start", async (event, ctx) => {
    const context = await runtimeContext(ctx.cwd)
    const root = process.env.AGENCY_WORKBASE ?? context?.root ?? discoverWorkbase(ctx.cwd)
    if (!root) return
    const checkout = process.env.AGENCY_WRITABLE_CHECKOUT ?? context?.checkout ?? discoverCheckout(ctx.cwd, root)
    const instructionsPath = join(root, ".agency", "AGENTS.md")
    const instructions = existsSync(instructionsPath)
      ? readFileSync(instructionsPath, "utf8").trim()
      : undefined
    const activeTarget = process.env.AGENCY_TARGET
    const worker = activeTarget && context?.target === activeTarget
      ? \`Agency verified this Pi session as the active worker for \${activeTarget}. Perform the assigned work directly. Do not invoke agency work for this target or launch a replacement worker.\`
      : undefined
    const access = \`The complete Agency workbase is available at \${root}. Use absolute paths under that root when workbase context is needed. Agency context remains the authority for writes.\`
    const implementation = checkout
      ? \`Pi remains rooted in the task or phase directory for Agency instructions and context. Treat \${checkout} as the default implementation directory for source reads, edits, repository status, builds, tests, formatting, and other repository-local commands. Run Agency lifecycle and context commands from the task or phase directory. Any reference checkouts reported by Agency context are read-only.\`
      : undefined

    return {
      systemPrompt: [event.systemPrompt, instructions, access, worker, implementation]
        .filter(Boolean)
        .join("\\n\\n"),
    }
  })
}

export default extension
`

const renderManagedWorkbasePiExtension = (content: string) =>
	`// agency-managed: sha256=${checksum(content)}\n\n${content}`

export const managedWorkbasePiExtension = renderManagedWorkbasePiExtension(body)

export const canUpdateManagedWorkbasePiExtension = (content: string) => {
	const match = content.match(managedHeaderPattern)
	if (!match?.[1]) return false

	return checksum(content.slice(match[0].length)) === match[1]
}
