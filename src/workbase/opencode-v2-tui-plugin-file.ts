import { createHash } from "node:crypto"

const managedHeaderPattern =
	/^\/\/ agency-managed: sha256=([a-f0-9]{64})\r?\n\r?\n/

const checksum = (content: string) =>
	createHash("sha256").update(content).digest("hex")

const managed = (content: string) =>
	`// agency-managed: sha256=${checksum(content)}\n\n${content}`

const packageBody = `${JSON.stringify(
	{
		name: "agency-tui",
		private: true,
		type: "module",
		exports: {
			".": "./index.ts",
			"./tui": "./tui.ts",
		},
	},
	null,
	2,
)}\n`

const indexBody = `const plugin = {
  id: "agency.tui.loader",
  setup() {},
  async server() {
    return {}
  },
}

export default plugin
`

const tuiBody = `const autosubmitTimeoutMs = 10_000
const autosubmitRetryMs = 25

type AutosubmitContext = {
  keymap: {
    commands(): readonly { id?: string }[]
    dispatch(id: string): unknown
  }
  renderer: { currentFocusedEditor?: unknown }
  ui: {
    router: { current(): { type: string } }
    toast: {
      show(input: {
        variant: "error"
        title: string
        message: string
        duration: number
      }): void
    }
  }
}

export const createAgencyAutosubmit = (
  options: { timeoutMs?: number; retryMs?: number } = {},
) => {
  let started = false

  return (context: AutosubmitContext) => {
    if (started) return () => {}
    if (process.env.AGENCY_TUI_AUTOSUBMIT !== "1") return () => {}
    if (!process.env.AGENCY_PROMPT) return () => {}
    started = true
    delete process.env.AGENCY_TUI_AUTOSUBMIT

    const timeoutMs = options.timeoutMs ?? autosubmitTimeoutMs
    const retryMs = options.retryMs ?? autosubmitRetryMs
    const deadline = Date.now() + timeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const stop = () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }

    const attempt = () => {
      if (stopped) return
      if (context.ui.router.current().type !== "home") {
        stop()
        return
      }

      const submitReady = context.keymap
        .commands()
        .some((command) => command.id === "prompt.submit")
      if (context.renderer.currentFocusedEditor && submitReady) {
        stop()
        context.keymap.dispatch("prompt.submit")
        return
      }

      if (Date.now() >= deadline) {
        stop()
        context.ui.toast.show({
          variant: "error",
          title: "Agency launch",
          message: "The task prompt is ready but could not be submitted automatically.",
          duration: 8_000,
        })
        return
      }
      timer = setTimeout(attempt, retryMs)
    }

    attempt()
    return stop
  }
}

const autosubmit = createAgencyAutosubmit()

export default {
  id: "agency.tui",
  setup(context: AutosubmitContext) {
    return autosubmit(context)
  },
}
`

export const managedWorkbaseOpencodeV2TuiPackage = packageBody
export const managedWorkbaseOpencodeV2TuiIndex = managed(indexBody)
export const managedWorkbaseOpencodeV2TuiPlugin = managed(tuiBody)

export const canUpdateManagedWorkbaseOpencodeV2TuiFile = (content: string) => {
	const match = content.match(managedHeaderPattern)
	if (!match?.[1]) return false
	return checksum(content.slice(match[0].length)) === match[1]
}
