import { prisma } from "./db";
import { connectedProjectIds } from "./projects";

// Matches [[Target]] and [[Target|alias]] — captures the target title only.
const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export function parseWikilinks(body: string): string[] {
  const titles = new Set<string>();
  WIKILINK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK.exec(body)) !== null) {
    const t = m[1].trim();
    if (t) titles.add(t);
  }
  return [...titles];
}

// Rebuild an item's outgoing links from its body. Targets resolve to an item
// with a matching title (case-insensitive) in this project OR a connected one.
// Unresolved targets are stored as ghost links (toItemId = null).
export async function syncItemLinks(itemId: string, projectId: string, body: string) {
  const titles = parseWikilinks(body);
  await prisma.link.deleteMany({ where: { fromItemId: itemId } });
  if (titles.length === 0) return;

  const projectIds = await connectedProjectIds(projectId);
  const candidates = await prisma.item.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true, title: true, projectId: true, updatedAt: true },
  });
  // Deterministic resolution for duplicate titles: prefer a match in this item's
  // OWN project, then the most-recently-updated, with a stable id tiebreak — so
  // the same [[title]] always resolves to the same item (no arbitrary DB order).
  candidates.sort((a, b) => {
    const ap = a.projectId === projectId ? 0 : 1;
    const bp = b.projectId === projectId ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const t = b.updatedAt.getTime() - a.updatedAt.getTime();
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const byTitle = new Map<string, string>();
  for (const c of candidates) {
    const key = c.title.toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, c.id);
  }

  await prisma.link.createMany({
    data: titles.map((t) => ({
      fromItemId: itemId,
      toItemId: byTitle.get(t.toLowerCase()) ?? null,
      targetTitle: t,
    })),
  });
}

// When an item is created or renamed, attach any existing ghost links that were
// pointing at this title (within connected projects) so the graph self-heals.
export async function resolveGhostLinks(itemId: string, projectId: string, title: string) {
  const projectIds = await connectedProjectIds(projectId);
  const ghosts = await prisma.link.findMany({
    where: { toItemId: null },
    select: { id: true, targetTitle: true, fromItem: { select: { projectId: true } } },
  });
  const target = title.toLowerCase();
  const ids = ghosts
    .filter((g) => g.targetTitle.toLowerCase() === target && projectIds.includes(g.fromItem.projectId))
    .map((g) => g.id);
  if (ids.length) {
    await prisma.link.updateMany({ where: { id: { in: ids } }, data: { toItemId: itemId } });
  }
}
