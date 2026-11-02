import type { DiffOmission } from "../infra/output-blocks.js"

/** Return the total number of diff lines removed at the history wire edge. */
export function totalDiffOmittedLines(omission: DiffOmission | undefined): number {
  if (omission === undefined) return 0
  return omission.kind === "aggregate"
    ? omission.omittedLines
    : omission.files.reduce((total, file) => total + file.omittedLines, 0)
}

/** Return the omitted-line count assigned to one rendered file section. */
export function diffOmittedLinesForFile(omission: DiffOmission | undefined, index: number, fileCount: number): number {
  if (omission === undefined) return 0
  if (omission.kind === "aggregate") return index === fileCount - 1 ? omission.omittedLines : 0
  return omission.files.find((file) => file.index === index)?.omittedLines ?? 0
}
