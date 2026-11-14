import { RefundError, refundSale, type RefundDeps } from "../payments/refunds";

export interface TillRequest {
  readonly params: Record<string, string>;
  readonly body: unknown;
}

export interface TillResponse {
  readonly status: number;
  readonly body: unknown;
}

function amountFrom(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null || !("amountCents" in body)) return undefined;
  return typeof body.amountCents === "number" ? body.amountCents : undefined;
}

/** POST /sales/:saleId/refunds with body { amountCents }. */
export async function postRefund(deps: RefundDeps, request: TillRequest): Promise<TillResponse> {
  const amountCents = amountFrom(request.body);
  if (amountCents === undefined) return { status: 400, body: { error: "amountCents is required" } };
  try {
    const refund = await refundSale(deps, request.params.saleId ?? "", amountCents);
    return { status: 201, body: refund };
  } catch (error) {
    if (error instanceof RefundError) return { status: 422, body: { error: error.message } };
    throw error;
  }
}
