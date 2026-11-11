import type { ImportReport } from "./importer.ts";

/** The summary the payables clerk sees after an upload. */
export function formatImportReport(report: ImportReport): string {
  const lines = [`Imported ${report.imported} invoice${report.imported === 1 ? "" : "s"}.`];
  for (const [currency, cents] of [...report.totals].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${currency} ${(cents / 100).toFixed(2)}`);
  }
  if (report.alreadyPosted.length > 0) {
    lines.push(`Skipped ${report.alreadyPosted.length} already posted: ${report.alreadyPosted.join(", ")}`);
  }
  return lines.join("\n");
}
