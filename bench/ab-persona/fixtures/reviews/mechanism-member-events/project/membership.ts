import type { AuditLog } from "./audit.ts";
import type { EventBus } from "./bus.ts";
import type { Database } from "./db.ts";

export class Membership {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly audit: AuditLog,
  ) {}

  async addMember(teamId: string, userId: string, role: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query("INSERT INTO members (team_id, user_id, role) VALUES (?, ?, ?)", [teamId, userId, role]);
      await tx.query("UPDATE teams SET member_count = member_count + 1 WHERE id = ?", [teamId]);
      this.bus.emit({ type: "member.added", teamId, userId, role });
    });
    await this.audit.record(teamId, `added ${userId} as ${role}`);
  }

  /** Returns false when the user was not a member. */
  async removeMember(teamId: string, userId: string): Promise<boolean> {
    const removed = await this.db.transaction(async (tx) => {
      const result = await tx.query("DELETE FROM members WHERE team_id = ? AND user_id = ?", [teamId, userId]);
      if (result.rowCount === 0) return false;
      await tx.query("UPDATE teams SET member_count = member_count - 1 WHERE id = ?", [teamId]);
      return true;
    });
    if (!removed) return false;
    this.bus.emit({ type: "member.removed", teamId, userId });
    await this.audit.record(teamId, `removed ${userId}`);
    return true;
  }
}
