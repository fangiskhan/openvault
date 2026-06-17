import { prisma } from "./db";
import { connectedProjectIds } from "./projects";
import { detectSignals, type Signal } from "./attention";

export type Rag = "green" | "amber" | "red";

export type Rollup = {
  projectId: string;
  projectName: string;
  computed: Rag;
  manual: string | null;
  manualNote: string | null;
  diverges: boolean;
  signalCount: number;
  topSignals: Signal[];
};

const ORDER: Record<Rag, number> = { green: 0, amber: 1, red: 2 };

// Computed RAG is intentionally calm: only a blocked-AND-overdue item is red;
// open risks / blockers / overdue / due-soon are amber. Manual health is
// returned ALONGSIDE (never merged) so the UI can flag human/machine divergence.
export function ragFrom(signals: Pick<Signal, "kind">[]): Rag {
  if (signals.some((s) => s.kind === "overdue_blocker")) return "red";
  if (signals.some((s) => s.kind === "open_risk" || s.kind === "blocker" || s.kind === "overdue" || s.kind === "due_soon")) {
    return "amber";
  }
  return "green";
}

export async function rollup(projectId: string, now: Date = new Date()): Promise<Rollup> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, health: true, healthNote: true },
  });
  const signals = await detectSignals([projectId], now);
  const computed = ragFrom(signals);
  const manual = project?.health ?? null;
  return {
    projectId,
    projectName: project?.name ?? "",
    computed,
    manual,
    manualNote: project?.healthNote ?? null,
    diverges: manual !== null && manual !== computed,
    signalCount: signals.length,
    topSignals: signals.slice(0, 5),
  };
}

export async function rollupMany(projectIds: string[], now: Date = new Date()) {
  const projects = await Promise.all(projectIds.map((id) => rollup(id, now)));
  const headline = projects.reduce<Rag>((worst, r) => (ORDER[r.computed] > ORDER[worst] ? r.computed : worst), "green");
  return { headline, projects };
}

export async function rollupConnected(projectId: string, now: Date = new Date()) {
  const ids = await connectedProjectIds(projectId);
  return rollupMany(ids, now);
}
