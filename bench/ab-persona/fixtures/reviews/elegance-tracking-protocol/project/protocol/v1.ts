/**
 * Wire format of the public tracking API, version 1. This file is published
 * to partner developers as its own package, so it imports nothing from the
 * server: a rename inside the server must never change what partners
 * receive. Each wire type is therefore spelled out here, even where it
 * matches a server type today. Version 1 only ever gains fields, and the
 * partner guide tells clients to ignore fields they do not know.
 */

export type ShipmentStateV1 = "label_created" | "in_transit" | "delivered";

/** Mirrors the server's DeliveryWindow on purpose (see the note at the top
 *  of this file). ISO 8601 timestamps in UTC. */
export interface DeliveryWindowV1 {
  from: string;
  to: string;
}

export interface ShipmentV1 {
  tracking_number: string;
  state: ShipmentStateV1;
  /** ISO 8601 timestamp in UTC. */
  last_scan_at: string;
  /** Null when the carrier has not given an estimate, or after delivery. */
  estimated_delivery: DeliveryWindowV1 | null;
}
