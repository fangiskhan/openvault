import { prisma } from "./db";

// All project ids "connected" to the given project (either direction),
// including the project itself. Connections are what let links and search
// cross the project boundary.
export async function connectedProjectIds(projectId: string): Promise<string[]> {
  const rels = await prisma.projectRelation.findMany({
    where: { OR: [{ fromProjectId: projectId }, { toProjectId: projectId }] },
    select: { fromProjectId: true, toProjectId: true },
  });
  const ids = new Set<string>([projectId]);
  for (const r of rels) {
    ids.add(r.fromProjectId);
    ids.add(r.toProjectId);
  }
  return [...ids];
}

// Resolve the project-id filter for a search scope.
//   "project"   -> just this project
//   "connected" -> this project + everything connected to it
//   "all"       -> null (no project filter; search everything)
export async function scopeProjectIds(
  projectId: string | null,
  scope: string,
): Promise<string[] | null> {
  if (scope === "all" || !projectId) return null;
  if (scope === "connected") return connectedProjectIds(projectId);
  return [projectId];
}
