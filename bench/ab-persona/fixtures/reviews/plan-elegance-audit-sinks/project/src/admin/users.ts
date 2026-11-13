export type Role = "member" | "admin";

export interface UserDirectory {
  remove(userId: string): Promise<boolean>;
  setRole(userId: string, role: Role): Promise<boolean>;
}
