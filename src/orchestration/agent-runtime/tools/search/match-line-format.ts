
/** Format one search result line with its one-based line number and marker. */
export function formatMatchLine(lineNumber: number, line: string, isMatch: boolean): string {
	const marker = isMatch ? "*" : " ";
	return `${marker}${lineNumber}|${line}`;
}
