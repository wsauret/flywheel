import type { Permit, PermitRepo } from "../src/permits";

export class MemoryPermitRepo implements PermitRepo {
  readonly permits = new Map<string, Permit>();

  async get(id: string): Promise<Permit | undefined> {
    return this.permits.get(id);
  }

  async save(permit: Permit): Promise<void> {
    this.permits.set(permit.id, permit);
  }
}
