import { dlopen, FFIType, ptr } from "bun:ffi"

/**
 * Native exec implementation using Bun FFI to call POSIX execvp.
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
	// Open libc to access execvp (platform-specific library paths)
	const libcPath =
		process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6"
	const libc = dlopen(libcPath, {
		execvp: {
			args: [FFIType.cstring, FFIType.ptr],
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

	// Call execvp - this will replace the current process if successful
	const fileBuffer = Buffer.from(file + "\0")
	const result = libc.symbols.execvp(ptr(fileBuffer), ptr(ptrs))

	// If we reach here, exec failed
	throw new Error(
		`execvp failed with code ${result}: Unable to execute '${file}'`,
	)
}
