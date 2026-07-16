interface ProgressOptions {
	readonly silent?: boolean
}

interface ProgressOutput {
	readonly isTTY: boolean
	readonly write: (text: string) => void
}

export interface Progress {
	readonly start: (message: string) => void
	readonly succeed: (message: string) => void
	readonly fail: (message: string) => void
}

const terminalOutput: ProgressOutput = {
	isTTY: Boolean(process.stderr.isTTY),
	write: (text) => process.stderr.write(text),
}

export const createProgress = (
	options: ProgressOptions,
	output: ProgressOutput = terminalOutput,
): Progress => {
	const enabled = !options.silent && output.isTTY
	const write = (symbol: string, message: string, complete: boolean) => {
		if (!enabled) return
		output.write(`\r\x1b[2K${symbol} ${message}${complete ? "\n" : ""}`)
	}

	return {
		start: (message) => write("\x1b[2m○\x1b[0m", message, false),
		succeed: (message) => write("\x1b[32m✓\x1b[0m", message, true),
		fail: (message) => write("\x1b[31m✗\x1b[0m", message, true),
	}
}
