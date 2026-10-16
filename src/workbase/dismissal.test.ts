import { describe, expect, test } from "bun:test"
import {
	dismissalApplies,
	dismissalAppliesToTriage,
	dismissalFingerprint,
	signalFingerprint,
} from "./dismissal"

const signals = [{ id: "agent_waiting:a", title: "Waiting" }]

describe("dismissal fingerprints", () => {
	test("digest signals independent of order, and nothing as empty", () => {
		const both = [...signals, { id: "pr_ready_to_merge:a", title: "Ready" }]
		expect(signalFingerprint(both)).toBe(signalFingerprint(both.toReversed()))
		expect(signalFingerprint([])).toBe("")
	})

	test("the supervisor needs the dismissed signals and a known triage state", () => {
		const signal = signalFingerprint(signals)
		const pinned = dismissalFingerprint(signal, "t1")
		expect(dismissalApplies(pinned, { signal, triage: "t1" })).toBe(true)
		expect(dismissalApplies(pinned, { signal, triage: null })).toBe(true)
		expect(dismissalApplies(pinned, { signal, triage: "t2" })).toBe(false)
		expect(dismissalApplies(pinned, { signal: "other", triage: "t1" })).toBe(
			false,
		)
		const early = dismissalFingerprint(signal, null)
		expect(dismissalApplies(early, { signal, triage: "t9" })).toBe(true)
		expect(dismissalApplies(null, { signal: "x", triage: null })).toBe(true)
	})

	test("triage compares its own part, or the signal part before any triage", () => {
		const signal = signalFingerprint(signals)
		expect(
			dismissalAppliesToTriage(dismissalFingerprint("s-old", "t1"), {
				signal,
				triage: "t1",
			}),
		).toBe(true)
		expect(
			dismissalAppliesToTriage(dismissalFingerprint(signal, null), {
				signal,
				triage: "t1",
			}),
		).toBe(true)
		expect(
			dismissalAppliesToTriage(dismissalFingerprint("s-old", null), {
				signal,
				triage: "t1",
			}),
		).toBe(false)
		// A bare triage fingerprint from before composite fingerprints.
		expect(dismissalAppliesToTriage("t1", { signal, triage: "t1" })).toBe(true)
	})
})
