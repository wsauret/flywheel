/** GET a path on the team directory service and return the decoded JSON
 *  body. Non-2xx responses reject with the status. */
export interface JsonClient {
  get(path: string): Promise<unknown>;
}
