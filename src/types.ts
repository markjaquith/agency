export interface Command {
	run: (args: string[], options: Record<string, any>) => Promise<void>
}
