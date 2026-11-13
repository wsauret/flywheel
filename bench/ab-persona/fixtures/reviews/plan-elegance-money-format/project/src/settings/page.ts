import { SYMBOL_CHOICES, type CurrencySymbol } from "./choices";
import { saveSettings, type ShopSettings } from "./load";

export interface SettingsForm {
  readonly shopName: string;
  readonly locale: string;
  readonly currencySymbol: CurrencySymbol;
}

export function currencyOptions(): readonly CurrencySymbol[] {
  return SYMBOL_CHOICES;
}

export async function submitSettings(path: string, form: SettingsForm): Promise<ShopSettings> {
  const settings: ShopSettings = { shopName: form.shopName.trim() || "My shop", locale: form.locale, currencySymbol: form.currencySymbol };
  await saveSettings(path, settings);
  return settings;
}
