import type { Database } from "bun:sqlite";
import type { IsoDate } from "./dates";

export interface Permit {
  readonly id: string;
  readonly residentId: string;
  readonly kind: "residential" | "business";
  readonly zone: string;
  readonly plate: string;
  readonly expiresOn: IsoDate;
}

export interface PermitRepo {
  get(id: string): Promise<Permit | undefined>;
  /** Insert or replace the whole permit. */
  save(permit: Permit): Promise<void>;
}

interface PermitRow {
  readonly id: string;
  readonly resident_id: string;
  readonly kind: "residential" | "business";
  readonly zone: string;
  readonly plate: string;
  readonly expires_on: string;
}

function fromRow(row: PermitRow): Permit {
  return { id: row.id, residentId: row.resident_id, kind: row.kind, zone: row.zone, plate: row.plate, expiresOn: row.expires_on };
}

export class SqlPermitRepo implements PermitRepo {
  constructor(private readonly db: Database) {}

  async get(id: string): Promise<Permit | undefined> {
    const row = this.db.query<PermitRow, [string]>("SELECT * FROM permits WHERE id = ?").get(id);
    return row === null ? undefined : fromRow(row);
  }

  async save(permit: Permit): Promise<void> {
    this.db
      .query(
        `INSERT INTO permits (id, resident_id, kind, zone, plate, expires_on)
         VALUES ($id, $residentId, $kind, $zone, $plate, $expiresOn)
         ON CONFLICT (id) DO UPDATE SET resident_id = excluded.resident_id, kind = excluded.kind,
           zone = excluded.zone, plate = excluded.plate, expires_on = excluded.expires_on`,
      )
      .run({ id: permit.id, residentId: permit.residentId, kind: permit.kind, zone: permit.zone, plate: permit.plate, expiresOn: permit.expiresOn });
  }
}
