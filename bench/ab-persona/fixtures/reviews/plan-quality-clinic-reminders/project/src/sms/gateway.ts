/** The SMS provider client. Every send is billed, whether or not the number can receive it. */
export interface SmsGateway {
  send(to: string, text: string): Promise<void>;
}
