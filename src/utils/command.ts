import { Effect, Layer } from "effect"
import { runEffect } from "./effect"

export interface BaseCommandOptions {
	readonly silent?: boolean
	readonly verbose?: boolean
}

type ServiceKey = "git" | "config" | "template" | "filesystem" | "prompt"

/**
 * Configuration for creating a command
 */
interface CommandConfig<
	TOptions extends BaseCommandOptions = BaseCommandOptions,
> {
	name: string
	services: readonly ServiceKey[]
	effect: (options: TOptions) => Effect.Effect<void, Error, any>
	help?: string
}

/**
 * Result of createCommand - the command and its exports
 */
interface CreatedCommand<
	TOptions extends BaseCommandOptions = BaseCommandOptions,
> {
	effect: (options: TOptions) => Effect.Effect<void, Error, any>
	execute: (options?: TOptions) => Promise<void>
	help?: string
}

/**
 * Creates a command with automatic service injection and boilerplate elimination
 *
 * This factory handles:
 * - Dynamic service imports
 * - Service layer provision
 * - Error handling through runEffect
 * - Command execution
 */
export function createCommand<
	TOptions extends BaseCommandOptions = BaseCommandOptions,
>(config: CommandConfig<TOptions>): CreatedCommand<TOptions> {
	return {
		effect: config.effect,
		execute: async (options: TOptions = {} as TOptions) => {
			const services: Layer.Layer<any, never, never>[] = []

			// Import and collect services based on configuration
			for (const serviceKey of config.services) {
				switch (serviceKey) {
					case "git": {
						const { GitServiceLive } = await import(
							"../services/GitServiceLive"
						)
						services.push(GitServiceLive)
						break
					}
					case "config": {
						const { ConfigServiceLive } = await import(
							"../services/ConfigServiceLive"
						)
						services.push(ConfigServiceLive)
						break
					}
					case "template": {
						const { TemplateServiceLive } = await import(
							"../services/TemplateServiceLive"
						)
						services.push(TemplateServiceLive)
						break
					}
					case "filesystem": {
						const { FileSystemServiceLive } = await import(
							"../services/FileSystemServiceLive"
						)
						services.push(FileSystemServiceLive)
						break
					}
					case "prompt": {
						const { PromptServiceLive } = await import(
							"../services/PromptServiceLive"
						)
						services.push(PromptServiceLive)
						break
					}
				}
			}

			// Execute the command effect with all services
			await runEffect(config.effect(options), services)
		},
		help: config.help ?? "",
	}
}
