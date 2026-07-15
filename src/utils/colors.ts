let colorsEnabled = !process.env.NO_COLOR

export function setColorsEnabled(enabled: boolean): void {
	colorsEnabled = enabled
}
