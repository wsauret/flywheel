import { withRetry } from "../lib/retry";

export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export class MailApiError extends Error {
  constructor(readonly status: number) {
    super(`Mail API returned ${status}`);
  }
}

export async function sendMail(apiUrl: string, mail: Mail, fetcher: typeof fetch = fetch): Promise<void> {
  await withRetry(async () => {
    const response = await fetcher(apiUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(mail) });
    if (!response.ok) throw new MailApiError(response.status);
  }, {
    attempts: 4,
    baseDelayMs: 250,
    isRetryable: (error) => !(error instanceof MailApiError) || error.status >= 500,
  });
}
