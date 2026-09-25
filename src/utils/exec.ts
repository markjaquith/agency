import { dlopen, FFIType, ptr } from "bun:ffi"

/**
 * PATH-resolving native exec using POSIX execve and an explicit environment.
 * This completely replaces the current process with the specified command.
 *
 * IMPORTANT: This function will never return if successful. The process
 * image is completely replaced with the new program.
 *
 * @param file - The program to execute (will be searched in PATH)
 * @param args - Array of arguments (first should be the program name)
 * @throws Error if exec fails (e.g., command not found)
 */
export function execvp(file: string, args: string[]): never {
	const executable = Bun.which(file)
	if (!executable) throw new Error(`Unable to find executable '${file}'`)
	// Bun's process.env mutations are not reflected in libc's environ. Passing
	// envp explicitly preserves launch identity and deletions across replacement.
	const variables = Object.entries(process.env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.map(([key, value]) => `${key}=${value}`)
	const libcPath =
		process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6"
	const libc = dlopen(libcPath, {
		execve: {
			args: [FFIType.cstring, FFIType.ptr, FFIType.ptr],
			returns: FFIType.int,
		},
	})

	// execvp expects argv as a null-terminated array of char* pointers
	// We need to convert our string array to C strings and create a pointer array
	const cstrings = args.map((arg) => Buffer.from(arg + "\0"))
	const ptrs = new BigUint64Array(args.length + 1)

	// Fill the pointer array with addresses of our C strings
	for (let i = 0; i < args.length; i++) {
		const buf = cstrings[i]
		if (buf) {
			ptrs[i] = BigInt(ptr(buf))
		}
	}
	// Null-terminate the pointer array
	ptrs[args.length] = 0n
	const environmentStrings = variables.map((value) => Buffer.from(value + "\0"))
	const environmentPointers = new BigUint64Array(environmentStrings.length + 1)
	for (let i = 0; i < environmentStrings.length; i++) {
		environmentPointers[i] = BigInt(ptr(environmentStrings[i]!))
	}

	// Call execvp - this will replace the current process if successful
	const fileBuffer = Buffer.from(executable + "\0")
	const result = libc.symbols.execve(
		ptr(fileBuffer),
		ptr(ptrs),
		ptr(environmentPointers),
	)

	// If we reach here, exec failed
	throw new Error(
		`execvp failed with code ${result}: Unable to execute '${file}'`,
	)
}
