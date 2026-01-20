import { describe, it, expect } from "bun:test"
import {
	parseTaskItems,
	countTasks,
	areAllTasksComplete,
	extractCompletionPromise,
	validateCompletion,
} from "./task-parser"

describe("task-parser", () => {
	describe("parseTaskItems", () => {
		it("should parse task items correctly", () => {
			const taskContent = `
# Tasks

- [ ] First task
- [x] Second task
- [ ] Third task
`

			const items = parseTaskItems(taskContent)
			expect(items).toHaveLength(3)
			expect(items[0]!.isComplete).toBe(false)
			expect(items[0]!.text).toBe("First task")
			expect(items[1]!.isComplete).toBe(true)
			expect(items[1]!.text).toBe("Second task")
			expect(items[2]!.isComplete).toBe(false)
			expect(items[2]!.text).toBe("Third task")
		})

		it("should handle empty task list", () => {
			const taskContent = `
# Tasks

No task items here
`

			const items = parseTaskItems(taskContent)
			expect(items).toHaveLength(0)
		})

		it("should parse task items with various bullet formats", () => {
			const taskContent = `
- [ ] Dash format unchecked
- [x] Dash format checked
* [ ] Asterisk format unchecked
* [X] Asterisk format uppercase
  - [ ] Indented unchecked
  - [x] Indented checked
`

			const items = parseTaskItems(taskContent)
			expect(items).toHaveLength(6)
			expect(items[0]!.isComplete).toBe(false)
			expect(items[1]!.isComplete).toBe(true)
			expect(items[2]!.isComplete).toBe(false)
			expect(items[3]!.isComplete).toBe(true)
			expect(items[4]!.isComplete).toBe(false)
			expect(items[5]!.isComplete).toBe(true)
		})

		it("should track line numbers", () => {
			const taskContent = `# Header
- [ ] First task
Some text
- [x] Second task`

			const items = parseTaskItems(taskContent)
			expect(items).toHaveLength(2)
			expect(items[0]!.lineNumber).toBe(2)
			expect(items[1]!.lineNumber).toBe(4)
		})
	})

	describe("countTasks", () => {
		it("should count completed and incomplete tasks", () => {
			const items = [
				{ text: "First", isComplete: false, lineNumber: 1 },
				{ text: "Second", isComplete: true, lineNumber: 2 },
				{ text: "Third", isComplete: false, lineNumber: 3 },
			]

			const counts = countTasks(items)
			expect(counts.completed).toBe(1)
			expect(counts.incomplete).toBe(2)
			expect(counts.total).toBe(3)
		})

		it("should handle empty list", () => {
			const counts = countTasks([])
			expect(counts.completed).toBe(0)
			expect(counts.incomplete).toBe(0)
			expect(counts.total).toBe(0)
		})
	})

	describe("areAllTasksComplete", () => {
		it("should return true when all tasks are complete", () => {
			const items = [
				{ text: "First", isComplete: true, lineNumber: 1 },
				{ text: "Second", isComplete: true, lineNumber: 2 },
			]
			expect(areAllTasksComplete(items)).toBe(true)
		})

		it("should return false when some tasks are incomplete", () => {
			const items = [
				{ text: "First", isComplete: true, lineNumber: 1 },
				{ text: "Second", isComplete: false, lineNumber: 2 },
			]
			expect(areAllTasksComplete(items)).toBe(false)
		})

		it("should return true for empty list", () => {
			expect(areAllTasksComplete([])).toBe(true)
		})
	})

	describe("extractCompletionPromise", () => {
		it("should extract completion promise from output", () => {
			const output = "Some output\n<promise>COMPLETE</promise>"
			expect(extractCompletionPromise(output)).toBe("COMPLETE")
		})

		it("should return null when no promise found", () => {
			const output = "No promise here"
			expect(extractCompletionPromise(output)).toBeNull()
		})

		it("should extract any promise content", () => {
			const output = "<promise>custom message</promise>"
			expect(extractCompletionPromise(output)).toBe("custom message")
		})
	})

	describe("validateCompletion", () => {
		it("should not throw when all tasks complete and claiming completion", () => {
			expect(() => {
				validateCompletion("COMPLETE", true)
			}).not.toThrow()
		})

		it("should not throw when not claiming completion", () => {
			expect(() => {
				validateCompletion(null, false)
			}).not.toThrow()
		})

		it("should throw when claiming completion but tasks remain", () => {
			expect(() => {
				validateCompletion("COMPLETE", false)
			}).toThrow(
				"Agent claimed completion with <promise>COMPLETE</promise> but incomplete tasks remain",
			)
		})

		it("should be case-insensitive for COMPLETE", () => {
			expect(() => {
				validateCompletion("complete", false)
			}).toThrow()
			expect(() => {
				validateCompletion("Complete", false)
			}).toThrow()
		})

		it("should not throw for non-COMPLETE messages", () => {
			expect(() => {
				validateCompletion("IN_PROGRESS", false)
			}).not.toThrow()
		})
	})
})
