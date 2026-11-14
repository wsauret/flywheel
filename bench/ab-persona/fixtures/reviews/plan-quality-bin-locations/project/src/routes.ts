import type { ItemRepo } from "./items";
import { renderPickList } from "./picklist";

export interface TerminalResponse {
  readonly status: number;
  readonly body: string;
}

/** GET /orders/:orderId/picklist */
export async function getPickList(repo: ItemRepo, orderId: string): Promise<TerminalResponse> {
  return { status: 200, body: await renderPickList(repo, orderId) };
}
