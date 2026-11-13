function quote(cell: string): string {
  return /[",\n\r]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/** RFC 4180 CSV: CRLF line ends, and a cell that holds a comma, quote, or line break is quoted. */
export function toCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return [headers, ...rows].map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n";
}
