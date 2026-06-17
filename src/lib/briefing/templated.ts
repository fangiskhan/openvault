import { prisma } from "../db";
import { detectSignals } from "../attention";
import { rollupMany, type Rag } from "../status";
import { scopeProjectIds } from "../projects";
import { CONTENT_TYPES } from "../validation";

// A deterministic, zero-token briefing built entirely from real items + the
// rule-based detector. Every entry points at a source item (click-to-proof).
// This is the offline-safe Slice 1 briefing; the grounded LLM version is Slice 2.
export type TemplatedBriefing = {
  scope: string;
  generatedAt: string;
  headline: { rag: Rag; text: string };
  attention: { itemId: string; title: string; label: string; reason: string; projectName: string }[];
  recentDecisions: { itemId: string; title: string; projectName: string }[];
  recentlyUpdated: { itemId: string; title: string; type: string; projectName: string; updatedAt: string }[];
  coverage: { itemsConsidered: number; projects: number; windowDays: number };
  generator: "templated";
};

const WINDOW_DAYS = 14;
const DECISION_RE = /(^|\n)\s*>?\s*decisions?\b|decided\s*:|#decision\b/i;

export async function buildTemplatedBriefing(
  projectId: string,
  scope: string,
  now: Date = new Date(),
): Promise<TemplatedBriefing> {
  let ids = await scopeProjectIds(projectId, scope);
  if (ids === null) ids = (await prisma.project.findMany({ select: { id: true } })).map((p) => p.id);

  const signals = await detectSignals(ids, now);
  const roll = await rollupMany(ids, now);
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);

  const recent = await prisma.item.findMany({
    where: { projectId: { in: ids }, type: { in: [...CONTENT_TYPES] }, updatedAt: { gte: windowStart } },
    orderBy: { updatedAt: "desc" },
    take: 12,
    select: { id: true, title: true, type: true, updatedAt: true, body: true, project: { select: { name: true } } },
  });
  const total = await prisma.item.count({ where: { projectId: { in: ids }, type: { in: [...CONTENT_TYPES] } } });

  const decisions = recent
    .filter((r) => DECISION_RE.test(r.body))
    .slice(0, 5)
    .map((r) => ({ itemId: r.id, title: r.title, projectName: r.project.name }));

  const rag = roll.headline;
  const critical = signals.filter((s) => s.label === "Critical").length;
  const high = signals.filter((s) => s.label === "High").length;
  const text =
    rag === "green"
      ? "On track — no blocking signals in the window."
      : rag === "amber"
        ? `Needs attention — ${signals.length} open signal${signals.length === 1 ? "" : "s"}.`
        : `At risk — ${critical} critical and ${high} high signal${high === 1 ? "" : "s"} need attention.`;

  return {
    scope,
    generatedAt: now.toISOString(),
    headline: { rag, text },
    attention: signals.slice(0, 8).map((s) => ({
      itemId: s.itemId,
      title: s.title,
      label: s.label,
      reason: s.reason,
      projectName: s.projectName,
    })),
    recentDecisions: decisions,
    recentlyUpdated: recent.slice(0, 6).map((r) => ({
      itemId: r.id,
      title: r.title,
      type: r.type,
      projectName: r.project.name,
      updatedAt: r.updatedAt.toISOString(),
    })),
    coverage: { itemsConsidered: total, projects: ids.length, windowDays: WINDOW_DAYS },
    generator: "templated",
  };
}
