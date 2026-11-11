import { addressFor, type Channel, type Contact, type Sender } from "./channels.ts";

export interface DeliveryAttempt {
  channel: Channel;
  error: string;
}

export interface DeliveryResult {
  /** The channel that delivered, or undefined when every channel failed. */
  deliveredBy: Channel | undefined;
  failures: DeliveryAttempt[];
}

export interface DeliveryStrategy {
  deliver(contact: Contact, channels: readonly Channel[], text: string): Promise<DeliveryResult>;
}

/** Try each channel in the user's order and stop at the first that delivers. */
export class FallbackDeliveryStrategy implements DeliveryStrategy {
  constructor(private readonly sender: Sender) {}

  async deliver(contact: Contact, channels: readonly Channel[], text: string): Promise<DeliveryResult> {
    const failures: DeliveryAttempt[] = [];
    for (const channel of channels) {
      try {
        await this.sender.send(channel, addressFor(contact, channel), text);
        return { deliveredBy: channel, failures };
      } catch (error) {
        failures.push({ channel, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { deliveredBy: undefined, failures };
  }
}

export function createDeliveryStrategy(sender: Sender): DeliveryStrategy {
  return new FallbackDeliveryStrategy(sender);
}
