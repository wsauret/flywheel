import { SYMBOL_CHOICES, type CurrencySymbol } from "./choices";

export interface ShopSettings {
  readonly shopName: string;
  readonly locale: string;
  readonly currencySymbol: CurrencySymbol;
}

export const DEFAULT_SETTINGS: ShopSettings = { shopName: "My shop", locale: "en-US", currencySymbol: "$" };

function isSymbol(value: unknown): value is CurrencySymbol {
  return SYMBOL_CHOICES.some((symbol) => symbol === value);
}

/** Intl throws for a malformed tag and drops an unknown one; both count as unsupported. */
function isSupportedLocale(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return Intl.NumberFormat.supportedLocalesOf(value).length > 0;
  } catch {
    return false;
  }
}

/** Reads settings.json. A missing file gives the defaults; an invalid field takes its default with a warning. */
export async function loadSettings(path: string, warn: (message: string) => void = console.warn): Promise<ShopSettings> {
  const file = Bun.file(path);
  if (!(await file.exists())) return DEFAULT_SETTINGS;
  const raw: unknown = await file.json().catch(() => undefined);
  const input = typeof raw === "object" && raw !== null ? { ...raw } : {};
  const shopName = "shopName" in input && typeof input.shopName === "string" ? input.shopName : DEFAULT_SETTINGS.shopName;
  const rawLocale = "locale" in input ? input.locale : undefined;
  const locale = isSupportedLocale(rawLocale) ? rawLocale : DEFAULT_SETTINGS.locale;
  if (rawLocale !== undefined && locale !== rawLocale) warn(`settings.json: locale ${JSON.stringify(rawLocale)} is not supported; using ${locale}`);
  const symbol = "currencySymbol" in input ? input.currencySymbol : undefined;
  if (!isSymbol(symbol)) warn(`settings.json: currencySymbol ${JSON.stringify(symbol)} is not one of ${SYMBOL_CHOICES.join(" ")}; using $`);
  return { shopName, locale, currencySymbol: isSymbol(symbol) ? symbol : DEFAULT_SETTINGS.currencySymbol };
}

export async function saveSettings(path: string, settings: ShopSettings): Promise<void> {
  await Bun.write(path, JSON.stringify(settings, null, 2));
}
