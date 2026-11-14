export type MembershipType = "adult" | "junior" | "family";
export type MemberStatus = "active" | "lapsed" | "cancelled";

export interface Member {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly membershipType: MembershipType;
  readonly status: MemberStatus;
  readonly createdAt: Date;
  /** When a club officer last edited the member; the admin list shows it as "last edited". */
  readonly updatedAt: Date;
}

export type MemberEdit = Partial<Pick<Member, "name" | "email" | "membershipType">>;

export class MemberStore {
  readonly #members = new Map<string, Member>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(input: Pick<Member, "id" | "name" | "email" | "membershipType">): Member {
    const at = this.now();
    const member: Member = { ...input, status: "active", createdAt: at, updatedAt: at };
    this.#members.set(member.id, member);
    return member;
  }

  /** An officer's edit from the admin screens. */
  update(id: string, edit: MemberEdit): Member {
    const member = this.get(id);
    const next: Member = { ...member, ...edit, updatedAt: this.now() };
    this.#members.set(id, next);
    return next;
  }

  /** The payment sync's write. It is not an officer's edit, so "last edited" does not move. */
  setStatus(id: string, status: MemberStatus): Member {
    const next: Member = { ...this.get(id), status };
    this.#members.set(id, next);
    return next;
  }

  get(id: string): Member {
    const member = this.#members.get(id);
    if (member === undefined) throw new Error(`Unknown member ${id}`);
    return member;
  }

  all(): readonly Member[] {
    return [...this.#members.values()];
  }
}
