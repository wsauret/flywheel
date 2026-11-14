import { RefundError, refundSale, type RefundDeps } from "../payments/refunds";

/** One return a customer registered in the web shop. */
export interface WebReturn {
  readonly saleId: string;
  readonly amountCents: number;
}

export interface ImportResult {
  readonly refunded: number;
  readonly rejected: readonly { readonly saleId: string; readonly reason: string }[];
}

/** The nightly job: refund every web-shop return. A rejected return is reported, not retried. */
export async function importReturns(deps: RefundDeps, returns: readonly WebReturn[]): Promise<ImportResult> {
  let refunded = 0;
  const rejected: { saleId: string; reason: string }[] = [];
  for (const webReturn of returns) {
    try {
      await refundSale(deps, webReturn.saleId, webReturn.amountCents);
      refunded++;
    } catch (error) {
      if (!(error instanceof RefundError)) throw error;
      rejected.push({ saleId: webReturn.saleId, reason: error.message });
    }
  }
  return { refunded, rejected };
}
