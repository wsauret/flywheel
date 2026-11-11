export type ShipmentState = "label_created" | "in_transit" | "delivered";

/** The carrier's promise: the parcel arrives between `from` and `to`. */
export interface DeliveryWindow {
  from: Date;
  to: Date;
}

export interface Shipment {
  trackingNumber: string;
  state: ShipmentState;
  lastScanAt: Date;
  /** Null until a hub scan carries an estimate, and again once delivered. */
  estimatedDelivery: DeliveryWindow | null;
}

export type Scan =
  | { kind: "picked_up"; at: Date }
  | { kind: "departed_hub"; at: Date; hub: string; estimate: DeliveryWindow | null }
  | { kind: "delivered"; at: Date };

/** A hub scan without an estimate keeps the previous one: carriers send a
 *  window only when it changes. */
export function applyScan(shipment: Shipment, scan: Scan): Shipment {
  switch (scan.kind) {
    case "picked_up":
      return { ...shipment, state: "in_transit", lastScanAt: scan.at };
    case "departed_hub":
      return { ...shipment, state: "in_transit", lastScanAt: scan.at, estimatedDelivery: scan.estimate ?? shipment.estimatedDelivery };
    case "delivered":
      return { ...shipment, state: "delivered", lastScanAt: scan.at, estimatedDelivery: null };
  }
}
