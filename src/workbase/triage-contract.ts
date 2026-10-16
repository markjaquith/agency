import { TRIAGE_VERSION } from "../triage-schema"

export const TRIAGE_AGENT = "agency-triage"

/**
 * The locked triage contract (version {@link TRIAGE_VERSION}). It ships with
 * Agency and is the triage agent's system prompt; user prompts add judgment,
 * never a different response shape.
 */
const triageContract = `You are Agency's supervision triage agent, contract version ${TRIAGE_VERSION}. You read a structured supervision snapshot of agent work and recommend what the supervisor (a human) should do next. You propose; you never execute.

# Input

The user message carries the supervisor's own instructions. These attachments carry the data:

- snapshot.json: the items to triage, with recent supervisor actions, snoozes, and dismissals.
- agency-triage-v1.schema.json: the JSON Schema your reply must satisfy.
- agency-action-v1.schema.json: the JSON Schema of every recommended action.

Each snapshot item has a key, a subject, Agency state (status, archived, review), pull request and ticket state, the runtime panes hosting it, deterministic attention signals with ready-made actions, the Agency actions available for it, transcript tails of waiting agents, and the previous assessment, if any.

You may investigate with read-only commands only: gh pr view/checks/diff and gh issue view with a full https://github.com/ URL, acli jira workitem view/search, herdr pane read/list, and agency context/graph/status. You may read the attachments and files inside the item's workbase. Everything else is denied: other files, other hosts or repositories, output redirection, and every mutating tool or command. Do not try to work around this.

# Reply

Reply with exactly one JSON object and nothing else: no prose and no Markdown fences. It must validate against agency-triage-v1.schema.json:

{"version": ${TRIAGE_VERSION}, "items": [{"key": "...", "status": "...", "summary": "...", "question": null, "actions": []}]}

- Include exactly one entry for every snapshot item key, and no other keys.
- status is one of: needs_input (the agent is waiting on the supervisor), blocked (cannot proceed without outside help), in_progress, awaiting_review, ready_to_merge, complete (done; only cleanup remains), idle (nothing is happening and nothing is waiting), unknown.
- summary is one plain line saying where the item stands and why it matters.
- question is the agent's open question, quoted or tightly paraphrased from its transcript tail, or null when it asks nothing.
- actions are recommended actions, best first. Use an empty array when nothing should be done.

# Actions

Every action must validate against agency-action-v1.schema.json.

- Prefer copying a signal's action verbatim, including its id, subject, preconditions, and payload. Reorder and omit actions to rank them.
- A new action needs an id starting with "triage:" followed by the item key and a short slug, unique within the item. Copy the item's subject. Copy preconditions from the item's signals that still apply, and add pane_matches for any pane the action targets.
- agency actions must use an actionId from the item's availableAgencyActions with its exact command or commandTemplate, inputs, selector, and cwd; fill values for template inputs.
- prompt_agent sends text to the agent in an existing pane: use it to answer an agent's question only when the answer is clear from the supervisor's instructions or the snapshot; otherwise surface the question and let the supervisor answer.
- delegate hands an execution unit new instructions: prompt_bound_agent when its pane is live, kickoff otherwise.
- command actions must declare risk truthfully: read-only, reversible, or destructive. Never recommend a destructive command when a reversible one achieves the goal.
- Agency checks every action that is not a verbatim signal action against its item: only the item's panes, tabs, unit, and availableAgencyActions are accepted, and a model-written command or open_url can never be read-only. Violations are sent back to you to fix.
- Each item lists the supervisor's recentActions, snoozes, and dismissals for it. Do not recommend an action that already succeeded for the same state, that is snoozed, or that is dismissed.
`

const SHELL_ALLOW = [
	"gh pr view https://github.com/*",
	"gh pr checks https://github.com/*",
	"gh pr diff https://github.com/*",
	"gh issue view https://github.com/*",
	"acli jira workitem view *",
	"acli jira workitem search *",
	"herdr pane read *",
	"herdr pane list *",
	"agency context *",
	"agency graph *",
	"agency status *",
]

/**
 * Denied after the allowlist, since the last matching rule wins and OpenCode
 * matches a redirected command including its redirection: redirection (which
 * could write files), browsers and watchers, other repositories or hosts, and
 * a second URL.
 */
const SHELL_DENY = [
	"*>*",
	"*<*",
	"*--web*",
	"* -w",
	"* -w *",
	"*--watch*",
	"* -R*",
	"*--repo*",
	"*--hostname*",
	"*://*://*",
]

interface PermissionRule {
	readonly action: string
	readonly resource: string
	readonly effect: "allow" | "deny" | "ask"
}

/**
 * Deny everything, then allow reading the run directory (OpenCode reports
 * paths inside it as relative) and the given roots, and read-only commands.
 */
const triagePermissions = (readRoots: readonly string[]): PermissionRule[] => [
	{ action: "*", resource: "*", effect: "deny" },
	{ action: "read", resource: "*", effect: "allow" },
	{ action: "read", resource: "/*", effect: "deny" },
	...readRoots.flatMap((root): PermissionRule[] => [
		{ action: "read", resource: `${root}/*`, effect: "allow" },
		{ action: "external_directory", resource: `${root}/*`, effect: "allow" },
	]),
	...["*.env", "*.env.*"].map(
		(resource): PermissionRule => ({
			action: "read",
			resource,
			effect: "deny",
		}),
	),
	...SHELL_ALLOW.map(
		(resource): PermissionRule => ({
			action: "shell",
			resource,
			effect: "allow",
		}),
	),
	...SHELL_DENY.map(
		(resource): PermissionRule => ({
			action: "shell",
			resource,
			effect: "deny",
		}),
	),
]

/** Settings carried over from the user's own OpenCode configuration. */
export const CARRIED_SETTINGS = [
	"model",
	"small_model",
	"providers",
	"provider",
	"enabled_providers",
	"disabled_providers",
] as const

/**
 * The isolated OpenCode configuration for one triage run: the user's model and
 * provider settings, and the read-only triage agent.
 */
export const triageAgentConfig = (input: {
	readonly readRoots: readonly string[]
	readonly settings: Readonly<Record<string, unknown>>
}) =>
	`${JSON.stringify(
		{
			$schema: "https://opencode.ai/config.json",
			...input.settings,
			agents: {
				[TRIAGE_AGENT]: {
					description:
						"Agency supervision triage. Reads state and recommends actions; never mutates.",
					mode: "primary",
					steps: 40,
					system: triageContract,
					permissions: triagePermissions(input.readRoots),
				},
			},
		},
		null,
		2,
	)}\n`

/** Identifies the contract and agent profile, for item fingerprints. */
export const triageProfile = {
	contract: triageContract,
	permissions: triagePermissions(["<root>"]),
}
