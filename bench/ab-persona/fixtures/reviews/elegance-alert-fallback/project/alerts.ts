import type { Sender } from "./channels.ts";
import { createDeliveryStrategy, type DeliveryResult, type DeliveryStrategy } from "./delivery.ts";
import type { PreferenceStore } from "./preferences.ts";

export interface Alert {
  userId: string;
  monitor: string;
  message: string;
}

export class AlertDispatcher {
  private readonly delivery: DeliveryStrategy;

  constructor(
    private readonly preferences: PreferenceStore,
    sender: Sender,
  ) {
    this.delivery = createDeliveryStrategy(sender);
  }

  /** Deliver the alert on the first channel that works. The result lists the
   *  channels that failed so the on-call page can show why an alert was late. */
  async dispatch(alert: Alert): Promise<DeliveryResult> {
    const { contact, channels } = this.preferences.get(alert.userId);
    return this.delivery.deliver(contact, channels, `[${alert.monitor}] ${alert.message}`);
  }
}
