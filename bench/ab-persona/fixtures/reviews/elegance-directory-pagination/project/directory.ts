import type { JsonClient } from "./json-client.ts";
import { fetchAllPages } from "./pagination.ts";

export interface Project {
  id: string;
  name: string;
}

export interface Member {
  login: string;
  role: "owner" | "member";
}

export function listProjects(client: JsonClient, org: string): Promise<Project[]> {
  return fetchAllPages(client, `/orgs/${encodeURIComponent(org)}/projects`, parseProject);
}

export function listMembers(client: JsonClient, org: string): Promise<Member[]> {
  return fetchAllPages(client, `/orgs/${encodeURIComponent(org)}/members`, parseMember);
}

function parseProject(value: unknown): Project {
  if (typeof value !== "object" || value === null) throw new Error("Project entry is not an object");
  const fields: Record<string, unknown> = { ...value };
  const { id, name } = fields;
  if (typeof id !== "string" || typeof name !== "string") throw new Error("Project entry needs string id and name");
  return { id, name };
}

function parseMember(value: unknown): Member {
  if (typeof value !== "object" || value === null) throw new Error("Member entry is not an object");
  const fields: Record<string, unknown> = { ...value };
  const { login, role } = fields;
  if (typeof login !== "string") throw new Error("Member entry needs a string login");
  if (role !== "owner" && role !== "member") throw new Error(`Member ${login} has unknown role ${String(role)}`);
  return { login, role };
}
