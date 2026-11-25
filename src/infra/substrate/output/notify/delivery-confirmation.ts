/**
 * Recognizes delivery receipts in historical tool results. Current writers
 * emit none; display folds still hide them and context masking preserves them.
 */

export const DELIVERY_CONFIRMATION = "[runtime delivery receipt: the reply text in this turn's assistant message was shown to the user. This line is turn metadata, not part of this tool's output.]";

/** Whether a tool-result text part is the receipt rather than tool output. */
export function isDeliveryConfirmationText(text: string): boolean {
  return text === DELIVERY_CONFIRMATION;
}
