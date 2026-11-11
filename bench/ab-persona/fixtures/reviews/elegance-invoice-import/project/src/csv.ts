/** Parse RFC 4180 CSV: comma separated, fields optionally wrapped in double
 *  quotes, a doubled quote inside a quoted field is a literal quote, and
 *  quoted fields may span lines. Accepts LF and CRLF line ends. A blank line
 *  yields no row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  const endRow = (): void => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    field = "";
  };
  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      endRow();
    } else if (char !== "\r" || text[index + 1] !== "\n") {
      field += char;
    }
    index++;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}
