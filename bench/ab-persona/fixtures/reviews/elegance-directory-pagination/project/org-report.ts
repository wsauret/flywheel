import { listMembers, listProjects } from "./directory.ts";
import type { JsonClient } from "./json-client.ts";

export async function orgReport(client: JsonClient, org: string): Promise<string> {
  const [projects, members] = await Promise.all([listProjects(client, org), listMembers(client, org)]);
  const owners = members.filter((member) => member.role === "owner").map((member) => member.login);
  return `${org}: ${projects.length} projects, ${members.length} members (owners: ${owners.join(", ") || "none"})`;
}
