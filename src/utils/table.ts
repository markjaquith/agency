export const formatTable = (
	headings: readonly string[],
	rows: readonly (readonly string[])[],
) => {
	const widths = headings.map((heading, index) =>
		Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
	)
	const line = (cells: readonly string[]) =>
		cells
			.map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
			.join("  ")
			.trimEnd()

	return [
		line(headings),
		line(widths.map((width) => "-".repeat(width))),
		...rows.map(line),
	].join("\n")
}
