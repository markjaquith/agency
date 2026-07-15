export function createLoggers(options: {
	readonly silent?: boolean
	readonly verbose?: boolean
}) {
	const { silent = false, verbose = false } = options
	return {
		log: silent ? () => {} : console.log,
		verboseLog: verbose && !silent ? console.log : () => {},
	}
}
