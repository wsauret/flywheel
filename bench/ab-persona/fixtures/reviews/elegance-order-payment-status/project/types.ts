export interface OrderLine {
  sku: string;
  unitCents: number;
  quantity: number;
}

export interface Payment {
  id: string;
  amountCents: number;
  receivedAt: number;
}

export type PaymentStatus = "unpaid" | "partially-paid" | "paid";

export interface Order {
  id: string;
  customerId: string;
  lines: readonly OrderLine[];
  payments: Payment[];
  paymentStatus: PaymentStatus;
}
