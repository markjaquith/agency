export function createLoggers(options: {
	readonly silent?: boolean
	readonly verbose?: boolean
	readonly json?: boolean
}) {
	const { silent = false, verbose = false, json = false } = options
	return {
		log: silent ? () => {} : console.log,
		verboseLog: verbose && !silent && !json ? console.log : () => {},
	}
}
