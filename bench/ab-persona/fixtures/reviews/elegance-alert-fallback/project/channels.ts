export const CHANNELS = ["email", "sms", "push"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Contact {
  email: string;
  phone: string;
  deviceToken: string;
}

export interface Sender {
  send(channel: Channel, address: string, text: string): Promise<void>;
}

export function addressFor(contact: Contact, channel: Channel): string {
  switch (channel) {
    case "email":
      return contact.email;
    case "sms":
      return contact.phone;
    case "push":
      return contact.deviceToken;
  }
}
