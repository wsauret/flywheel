import { PaymentDeclined, ZONE_FEES, type Payments } from "./payments";
import type { PermitRepo } from "./permits";

export interface PortalDeps {
  readonly permits: PermitRepo;
  readonly payments: Payments;
  readonly newId: () => string;
}

export interface Session {
  readonly residentId: string;
}

export interface PortalResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface NewPermitBody {
  readonly zone: string;
  readonly plate: string;
  readonly cardToken: string;
  readonly expiresOn: string;
}

/** POST /permits: buy a residential permit. Charges first, then writes the permit (README.md, Payments). */
export async function postNewPermit(deps: PortalDeps, session: Session, body: NewPermitBody): Promise<PortalResponse> {
  const fee = ZONE_FEES[body.zone];
  if (fee === undefined) return { status: 400, body: { error: `Unknown zone ${body.zone}` } };
  const id = deps.newId();
  try {
    await deps.payments.charge(body.cardToken, fee, `permit:${id}:new`);
  } catch (error) {
    if (error instanceof PaymentDeclined) return { status: 402, body: { error: "The card was declined." } };
    throw error;
  }
  const permit = { id, residentId: session.residentId, kind: "residential" as const, zone: body.zone, plate: body.plate, expiresOn: body.expiresOn };
  await deps.permits.save(permit);
  return { status: 201, body: permit };
}
