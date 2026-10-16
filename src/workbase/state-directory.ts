import { join } from "node:path"

/**
 * Local operational state (runtime bindings, supervision state) lives under
 * $AGENCY_STATE_DIR (default: $XDG_STATE_HOME/agency or ~/.local/state/agency),
 * never in durable workbase content.
 */
export const agencyStateDirectory = (env: NodeJS.ProcessEnv = process.env) =>
	env.AGENCY_STATE_DIR ||
	join(env.XDG_STATE_HOME || join(env.HOME ?? ".", ".local", "state"), "agency")
