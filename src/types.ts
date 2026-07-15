export interface Command {
	name: string
	description: string
	run: (
		args: string[],
		options: Record<string, any>,
		rawArgs?: string[],
	) => Promise<void>
	help?: string
}
