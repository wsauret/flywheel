export interface CustomerRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly points_balance: number;
}

/** The storage port. The production adapter runs SQL against the customers table and maps each CustomerRow field to the column of the same name. */
export interface Database {
  getCustomerRow(id: string): Promise<CustomerRow | undefined>;
  updateCustomerRow(row: CustomerRow): Promise<void>;
}
