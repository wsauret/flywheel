/** The currency symbols the settings page offers. Releases up to now store the chosen symbol. */
export const SYMBOL_CHOICES = ["$", "€", "£"] as const;
export type CurrencySymbol = (typeof SYMBOL_CHOICES)[number];
