import type { Shipment } from "../domain/shipment.ts";
import type { ShipmentV1 } from "../protocol/v1.ts";

export function toShipmentV1(shipment: Shipment): ShipmentV1 {
  const window = shipment.estimatedDelivery;
  return {
    tracking_number: shipment.trackingNumber,
    state: shipment.state,
    last_scan_at: shipment.lastScanAt.toISOString(),
    estimated_delivery: window === null ? null : { from: window.from.toISOString(), to: window.to.toISOString() },
  };
}
