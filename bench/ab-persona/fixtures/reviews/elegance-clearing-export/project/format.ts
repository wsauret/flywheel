export function formatDate(epochMs: number): string {
  const date = new Date(epochMs);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

export function formatAmount(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}
