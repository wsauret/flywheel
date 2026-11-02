/** PowerShell states an error behind a coloured gutter and folds it to the
 *  width of the terminal, so the message it wrapped is not one line of its
 *  stderr. This is that message: the colour sequences taken out, and the gutter
 *  and the fold read as one space. The escape byte is built rather than
 *  written, because a control character in a pattern is a defect everywhere
 *  else. */
const ESCAPE = String.fromCharCode(27);

export function statedMessage(stderr: string): string {
  return stderr
    .split(ESCAPE)
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/, "")))
    .join("")
    .replaceAll(/\s*\|\s*/g, " ")
    .replaceAll(/\s+/g, " ");
}
