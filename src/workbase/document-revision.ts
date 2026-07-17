export const documentRevision = (content: string) =>
	new Bun.CryptoHasher("sha256").update(content).digest("hex")
