import { Context, Effect, Layer } from "effect"
import { githubTicketProvider } from "./github"
import { jiraTicketProvider } from "./jira"
import type { TicketProvider } from "./provider"

export class TicketProviderRegistry extends Context.Service<TicketProviderRegistry>()(
	"TicketProviderRegistry",
	{
		make: Effect.succeed({
			providers: [
				jiraTicketProvider,
				githubTicketProvider,
			] as readonly TicketProvider[],
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
