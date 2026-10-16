/**
 * A dismissal pins `<signal fingerprint>:<triage fingerprint>` so it lapses
 * when an item's deterministic signals change, not only when triage notices.
 */

/** A digest of an item's signals; empty when it has none. */
export const signalFingerprint = (
	signals: readonly { readonly id: string; readonly title: string }[],
) =>
	signals.length === 0
		? ""
		: new Bun.CryptoHasher("sha256")
				.update(
					signals
						.map((signal) => `${signal.id}\u0000${signal.title}`)
						.sort()
						.join("\u0001"),
				)
				.digest("hex")
				.slice(0, 16)

export const dismissalFingerprint = (signal: string, triage: string | null) =>
	`${signal}:${triage ?? ""}`

const parts = (fingerprint: string) => {
	const at = fingerprint.indexOf(":")
	return at < 0
		? null
		: { signal: fingerprint.slice(0, at), triage: fingerprint.slice(at + 1) }
}

/**
 * For the supervisor: the dismissed signals must be the current ones, and a
 * recorded triage fingerprint must match triage's current one when known.
 */
export const dismissalApplies = (
	fingerprint: string | null,
	current: { readonly signal: string; readonly triage: string | null },
) => {
	if (fingerprint === null) return true
	const pinned = parts(fingerprint)
	if (!pinned)
		return fingerprint === current.signal || fingerprint === current.triage
	return (
		pinned.signal === current.signal &&
		(pinned.triage === "" ||
			current.triage === null ||
			pinned.triage === current.triage)
	)
}

/**
 * For triage: compare the triage part, or the signal part when the dismissal
 * predates any triage of the item.
 */
export const dismissalAppliesToTriage = (
	fingerprint: string | null,
	current: { readonly signal: string; readonly triage: string },
) => {
	if (fingerprint === null) return true
	const pinned = parts(fingerprint)
	if (!pinned)
		return fingerprint === current.triage || fingerprint === current.signal
	return pinned.triage === ""
		? pinned.signal === current.signal
		: pinned.triage === current.triage
}
