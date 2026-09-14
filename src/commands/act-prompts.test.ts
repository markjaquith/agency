import { expect, test } from "bun:test"
import { Effect } from "effect"
import { actionPrompts, ActCancelled, wizardInputs } from "./act-prompts"

test("wizard rejects malformed and duplicate phase IDs at the ID prompt", async () => {
	const answers = ["Kept outcome", "../bad", "build", "build-next"]
	const seen: string[] = []
	const errors: string[] = []
	const result = await Effect.runPromise(
		wizardInputs(
			{
				select: () => Effect.succeed(null),
				text: (prompt) =>
					Effect.sync(() => {
						seen.push(prompt)
						if (!answers.length) throw new Error("Unexpected prompt")
						return answers.shift()!
					}),
			},
			(ui) =>
				Effect.gen(function* () {
					const p = actionPrompts(ui, [], ["multi/build"])
					const outcome = yield* p.text("Outcome")
					const id = yield* p.id("Phase ID", "build", "multi/")
					return { outcome, id }
				}),
			() => true,
			(message) => {
				if (message) errors.push(message)
			},
		),
	)
	expect(result).toEqual({ outcome: "Kept outcome", id: "build-next" })
	expect(seen).toEqual([
		"Outcome: ",
		"Phase ID [build-2]: ",
		"Phase ID [build-2]: ",
		"Phase ID [build-2]: ",
	])
	expect(errors[0]).toContain("must start with a letter or number")
	expect(errors[1]).toBe("Phase ID 'build' is already in use")
})

test("wizard retries a required field without losing preceding answers", async () => {
	const answers = ["Kept outcome", "", "", "fixed"]
	const prompts: string[] = []
	const errors: (string | undefined)[] = []
	const result = await Effect.runPromise(
		wizardInputs(
			{
				select: () => Effect.succeed(null),
				text: (prompt) =>
					Effect.sync(() => {
						prompts.push(prompt)
						if (!answers.length) throw new Error("Unexpected prompt")
						return answers.shift()!
					}),
			},
			(ui) =>
				Effect.gen(function* () {
					const p = actionPrompts(ui, [], [])
					const outcome = yield* p.text("Outcome")
					const id = yield* p.text("ID")
					return { outcome, id }
				}),
			() => true,
			(message) => errors.push(message),
		),
	)
	expect(prompts).toEqual(["Outcome: ", "ID: ", "ID: ", "ID: "])
	expect(result).toEqual({ outcome: "Kept outcome", id: "fixed" })
	expect(errors.filter(Boolean)).toEqual(["ID is required", "ID is required"])
	expect(errors.at(-1)).toBeUndefined()
})

test("wizard replays choice keys against current values and isolates each execution", async () => {
	let generation = 0
	let selections = 0
	const answers = [
		"old",
		null,
		"changed",
		"last",
		"old",
		null,
		"changed",
		"last",
	]
	const collect = wizardInputs(
		{
			select: (_, choices) =>
				Effect.sync(() => {
					selections++
					return choices[0]!.value
				}),
			text: () => Effect.sync(() => answers.shift()!),
		},
		(ui) =>
			Effect.gen(function* () {
				const current = ++generation
				const selected = yield* ui.select("Repository", [
					{ key: "demo", label: "Demo", value: { generation: current } },
				])
				const p = actionPrompts(ui, [], [])
				const second = yield* p.text("Second")
				yield* p.text("Third")
				return { selected, second }
			}),
		() => true,
	)
	expect(await Effect.runPromise(collect)).toEqual({
		selected: { generation: 2 },
		second: "changed",
	})
	expect(await Effect.runPromise(collect)).toEqual({
		selected: { generation: 4 },
		second: "changed",
	})
	expect(selections).toBe(2)
})

test("wizard propagates input failures without replaying the collector", async () => {
	const failure = new Error("Terminal unavailable")
	let runs = 0
	const result = await Effect.runPromise(
		Effect.either(
			wizardInputs(
				{
					select: () => Effect.succeed(null),
					text: () => Effect.fail(failure),
				},
				(ui) =>
					Effect.suspend(() => {
						runs++
						return actionPrompts(ui, [], []).text("Outcome")
					}),
				() => true,
			),
		),
	)
	expect(result._tag).toBe("Left")
	if (result._tag === "Left") expect(result.left).toBe(failure)
	expect(runs).toBe(1)
})

test("wizard Escape returns one visible prompt and recomputes later defaults", async () => {
	const answers = [
		"Original outcome",
		"original",
		null,
		null,
		"Changed outcome",
		"",
		"main",
	]
	const seen: string[] = []
	const result = await Effect.runPromise(
		wizardInputs(
			{
				select: () => Effect.die("Single repository should not prompt"),
				text: (prompt) =>
					Effect.sync(() => {
						seen.push(prompt)
						if (!answers.length) throw new Error("Unexpected prompt")
						return answers.shift()!
					}),
			},
			(ui) =>
				Effect.gen(function* () {
					const p = actionPrompts(ui, ["demo"], [])
					const description = yield* p.text("Outcome")
					const id = yield* p.id("ID", description)
					const repo = yield* p.repository()
					const base = yield* p.text("Base", "main")
					return { description, id, repo, base }
				}),
			() => true,
		),
	)
	expect(seen).toEqual([
		"Outcome: ",
		"ID [original-outcome]: ",
		"Base [main]: ",
		"ID [original-outcome]: ",
		"Outcome: ",
		"ID [changed-outcome]: ",
		"Base [main]: ",
	])
	expect(result).toEqual({
		description: "Changed outcome",
		id: "changed-outcome",
		repo: "demo",
		base: "main",
	})
})

test("wizard leaves cancellation at the first prompt and global navigation alone", async () => {
	for (const global of [false, true]) {
		let calls = 0
		const result = await Effect.runPromise(
			Effect.either(
				wizardInputs(
					{
						select: () => Effect.succeed(null),
						text: () =>
							Effect.sync(() => (global && calls++ === 0 ? "first" : null)),
					},
					(ui) =>
						Effect.gen(function* () {
							const p = actionPrompts(ui, [], [])
							yield* p.text("First")
							return yield* p.text("Second")
						}),
					() => !global,
				),
			),
		)
		expect(result._tag).toBe("Left")
		if (result._tag === "Left") expect(result.left).toBeInstanceOf(ActCancelled)
	}
})
