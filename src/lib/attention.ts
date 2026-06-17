import { prisma } from "./db";

export type SignalKind = "overdue_blocker" | "open_risk" | "blocker" | "overdue" | "due_soon" | "stale";

export type Signal = {
  kind: SignalKind;
  itemId: string;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  title: string;
  type: string;
  status: string | null;
  dueAt: string | null;
  score: number;
  label: "Critical" | "High" | "Watch";
  reason: string;
};

// The fields the rules look at — kept separate from the DB row so the rules are
// pure and unit-testable without a database.
export type ClassifyInput = {
  type: string;
  status: string | null;
  dueAt: Date | null;
  closedAt: Date | null;
  updatedAt: Date;
};

const STALE_DAYS = 14;
const DUE_SOON_DAYS = 3;
const DAY = 86_400_000;

export function labelFor(score: number): Signal["label"] {
  if (score >= 90) return "Critical";
  if (score >= 50) return "High";
  return "Watch";
}

// Pure, deterministic classification of one item. No AI, no DB. Returns null
// when the item needs no attention. This is the load-bearing rule set (tested).
export function classify(it: ClassifyInput, now: Date): { kind: SignalKind; score: number; reason: string } | null {
  const resolved =
    it.closedAt !== null || it.status === "done" || it.status === "closed" || it.status === "accepted";
  if (resolved) return null;

  const overdue = it.dueAt !== null && it.dueAt < now;
  const blocked = it.status === "blocked";
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  if (it.type === "risk") {
    return { kind: "open_risk", score: 80, reason: it.status === "mitigating" ? "Open risk — mitigating" : "Open risk" };
  }
  if (overdue && blocked) return { kind: "overdue_blocker", score: 95, reason: `Blocked and overdue (due ${ymd(it.dueAt!)})` };
  if (blocked) return { kind: "blocker", score: 70, reason: "Blocked" };
  if (overdue) return { kind: "overdue", score: 55, reason: `Overdue (due ${ymd(it.dueAt!)})` };
  if (it.dueAt !== null && it.dueAt >= now && it.dueAt.getTime() <= now.getTime() + DUE_SOON_DAYS * DAY) {
    return { kind: "due_soon", score: 35, reason: `Due ${ymd(it.dueAt)}` };
  }
  if (it.updatedAt.getTime() < now.getTime() - STALE_DAYS * DAY) {
    return { kind: "stale", score: 20, reason: `No update in ${STALE_DAYS}+ days` };
  }
  return null;
}

// Detect "areas needing attention" across the given projects. Every signal
// points at a real item the caller can open.
export async function detectSignals(projectIds: string[], now: Date = new Date()): Promise<Signal[]> {
  if (projectIds.length === 0) return [];

  const items = await prisma.item.findMany({
    where: { projectId: { in: projectIds }, type: { in: ["task", "risk"] } },
    select: {
      id: true,
      projectId: true,
      title: true,
      type: true,
      status: true,
      dueAt: true,
      closedAt: true,
      updatedAt: true,
      project: { select: { name: true, color: true } },
    },
  });

  const signals: Signal[] = [];
  for (const it of items) {
    const c = classify(it, now);
    if (!c) continue;
    signals.push({
      kind: c.kind,
      score: c.score,
      reason: c.reason,
      label: labelFor(c.score),
      itemId: it.id,
      projectId: it.projectId,
      projectName: it.project.name,
      projectColor: it.project.color,
      title: it.title,
      type: it.type,
      status: it.status,
      dueAt: it.dueAt ? it.dueAt.toISOString() : null,
    });
  }

  signals.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return signals;
}
