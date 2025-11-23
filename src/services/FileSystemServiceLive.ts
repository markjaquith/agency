import { Effect, Layer } from "effect"
import { mkdir, copyFile as fsCopyFile, unlink } from "node:fs/promises"
import {
	FileSystemService,
	FileSystemError,
	FileNotFoundError,
} from "./FileSystemService"

export const FileSystemServiceLive = Layer.succeed(
	FileSystemService,
	FileSystemService.of({
		exists: (path: string) =>
			Effect.tryPromise({
				try: async () => {
					const file = Bun.file(path)
					return await file.exists()
				},
				catch: () =>
					new FileSystemError({
						message: `Failed to check if file exists: ${path}`,
					}),
			}),

		readFile: (path: string) =>
			Effect.tryPromise({
				try: async () => {
					const file = Bun.file(path)
					const exists = await file.exists()
					if (!exists) {
						throw new Error(`File not found: ${path}`)
					}
					return await file.text()
				},
				catch: () => new FileNotFoundError({ path }),
			}),

		writeFile: (path: string, content: string) =>
			Effect.tryPromise({
				try: async () => {
					try {
						await Bun.write(path, content)
					} catch {}
				},
				catch: () =>
					new FileSystemError({
						message: `Failed to write file: ${path}`,
					}),
			}),

		readJSON: <T>(path: string) =>
			Effect.tryPromise({
				try: async () => {
					const file = Bun.file(path)
					const exists = await file.exists()
					if (!exists) {
						throw new Error(`File not found: ${path}`)
					}
					return await file.json()
				},
				catch: () => new FileNotFoundError({ path }),
			}),

		writeJSON: <T>(path: string, data: T) =>
			Effect.tryPromise({
				try: () => Bun.write(path, JSON.stringify(data, null, 2) + "\n"),
				catch: (error) =>
					new FileSystemError({
						message: `Failed to write JSON file: ${path}`,
						cause: error,
					}),
			}),

		createDirectory: (path: string) =>
			Effect.tryPromise({
				try: async () => {
					try {
						await mkdir(path, { recursive: true })
					} catch {}
				},
				catch: () =>
					new FileSystemError({
						message: `Failed to create directory: ${path}`,
					}),
			}),

		deleteFile: (path: string) =>
			Effect.tryPromise({
				try: () => unlink(path),
				catch: (error) =>
					new FileSystemError({
						message: `Failed to delete file: ${path}`,
						cause: error,
					}),
			}),

		copyFile: (from: string, to: string) =>
			Effect.tryPromise({
				try: () => fsCopyFile(from, to),
				catch: (error) =>
					new FileSystemError({
						message: `Failed to copy file from ${from} to ${to}`,
						cause: error,
					}),
			}),
	}),
)
