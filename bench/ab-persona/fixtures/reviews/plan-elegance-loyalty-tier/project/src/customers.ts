import type { CustomerRow, Database } from "./db";

export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly pointsBalance: number;
}

function fromRow(row: CustomerRow): Customer {
  return { id: row.id, name: row.name, email: row.email, pointsBalance: row.points_balance };
}

function toRow(customer: Customer): CustomerRow {
  return { id: customer.id, name: customer.name, email: customer.email, points_balance: customer.pointsBalance };
}

export async function getCustomer(db: Database, id: string): Promise<Customer> {
  const row = await db.getCustomerRow(id);
  if (row === undefined) throw new Error(`Unknown customer ${id}`);
  return fromRow(row);
}

/** The only two writers of a points balance. */
export async function awardPoints(db: Database, id: string, points: number): Promise<Customer> {
  const customer = await getCustomer(db, id);
  const next = { ...customer, pointsBalance: customer.pointsBalance + points };
  await db.updateCustomerRow(toRow(next));
  return next;
}

export async function redeemPoints(db: Database, id: string, points: number): Promise<Customer> {
  const customer = await getCustomer(db, id);
  if (points > customer.pointsBalance) throw new Error("Insufficient points");
  const next = { ...customer, pointsBalance: customer.pointsBalance - points };
  await db.updateCustomerRow(toRow(next));
  return next;
}
