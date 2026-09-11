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
const autosubmitRetryMs = 100

type AutosubmitObservation = {
  event: "marker" | "dispatch" | "submitted" | "timeout" | "error"
  detail?: string
  dispatches: number
}

type AutosubmitMessage = {
  type?: string
  text?: string
  info?: { role?: string }
  role?: string
  parts?: readonly { type?: string; text?: string }[]
}

type AutosubmitContext = {
  keymap: {
    commands(): readonly { id?: string }[]
    dispatch(id: string): unknown
  }
  data?: {
    session?: {
      message?: {
        sync?(sessionID: string): Promise<unknown>
        list?(sessionID: string): readonly AutosubmitMessage[] | undefined
      }
    }
  }
  ui: {
    router: { current(): { type: string; sessionID?: string } }
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
  options: {
    timeoutMs?: number
    retryMs?: number
    observe?: (observation: AutosubmitObservation) => void
  } = {},
) => {
  let started = false

  return (context: AutosubmitContext) => {
    if (started) return () => {}
    if (process.env.AGENCY_TUI_AUTOSUBMIT !== "1") return () => {}
    if (!process.env.AGENCY_PROMPT) return () => {}
    started = true

    const timeoutMs = options.timeoutMs ?? autosubmitTimeoutMs
    const retryMs = options.retryMs ?? autosubmitRetryMs
    const deadline = Date.now() + timeoutMs
    const prompt = process.env.AGENCY_PROMPT
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let dispatches = 0
    let lastRoute = "unknown"

    const observe = (event: AutosubmitObservation["event"], detail?: string) => {
      const observation = { event, detail, dispatches }
      options.observe?.(observation)
      if (
        !options.observe &&
        (event !== "dispatch" || dispatches === 1 || dispatches % 10 === 0)
      ) {
        const suffix = detail ? ": " + detail : ""
        console.info("[agency.tui] autosubmit " + event + suffix)
      }
    }

    const stop = () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }

    const submitted = async (sessionID: string) => {
      const messages = context.data?.session?.message
      if (!messages?.list) return false
      try {
        await messages.sync?.(sessionID)
      } catch (error) {
        observe("error", "message sync failed: " + String(error))
        return false
      }
      return (messages.list(sessionID) ?? []).some((message) => {
        const role = message.type === "user" ? "user" : message.info?.role ?? message.role
        const text =
          message.text ??
          (message.parts ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("")
        return role === "user" && text === prompt
      })
    }

    const finish = (event: "submitted" | "timeout", detail: string) => {
      stop()
      delete process.env.AGENCY_TUI_AUTOSUBMIT
      observe(event, detail)
    }

    const attempt = async () => {
      if (stopped) return
      const route = context.ui.router.current()
      lastRoute = route.type
      if (route.type === "session" && route.sessionID) {
        if (await submitted(route.sessionID)) {
          finish(
            "submitted",
            dispatches === 0
              ? "native OpenCode submission observed"
              : "submitted message observed after companion dispatch",
          )
          return
        }
      }

      if (stopped) return
      if (Date.now() >= deadline) {
        finish(
          "timeout",
          "route=" + lastRoute + ", dispatches=" + String(dispatches),
        )
        context.ui.toast.show({
          variant: "error",
          title: "Agency launch",
          message:
            "The task prompt was not observed as submitted after " +
            String(dispatches) +
            " automatic attempt(s). Press Enter to submit it manually.",
          duration: 8_000,
        })
        return
      }

      const submitReady = context.keymap
        .commands()
        .some((command) => command.id === "prompt.submit")
      if (route.type === "home" && submitReady) {
        dispatches += 1
        observe("dispatch", "prompt.submit")
        try {
          await context.keymap.dispatch("prompt.submit")
        } catch (error) {
          observe("error", "dispatch failed: " + String(error))
        }
      }
      if (!stopped) timer = setTimeout(() => void attempt(), retryMs)
    }

    observe("marker", "autonomous prompt detected")
    void attempt()
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
