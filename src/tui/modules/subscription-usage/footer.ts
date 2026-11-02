export interface UsageFooterVariant {
  readonly view: "accounts" | "spend" | "history"
}

export function usageFooterRows(variant: UsageFooterVariant): readonly [string, string] {
  if (variant.view === "accounts") return ["PgUp/PgDn · wheel · c detail", "↑↓/jk source · a/s/h ·"]
  if (variant.view === "spend") return ["↑↓/jk source · ←→ range", "enter acct · a/s/h ·"]
  return ["↑↓/jk source · ←→ range", "a/s/h views · esc ·"]
}
