declare module "@triggi/native-exec" {
	function exec(
		command: string,
		env?: NodeJS.ProcessEnv,
		...args: string[]
	): void
	export default exec
}
