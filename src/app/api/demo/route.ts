import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { seedDemoData } from "@/lib/demo";
import { badRequest } from "@/lib/http";

// POST /api/demo — populate a fresh vault with the illustrative demo dataset so a
// first-run user (or an evaluator) sees a working Status board, graph, and linked
// notes immediately. Only works on an EMPTY vault so it can never clobber real
// data. Guarded by the human auth gate.
export async function POST() {
  const denied = await requireAuth();
  if (denied) return denied;

  const existing = await prisma.project.count();
  if (existing > 0) return badRequest("demo data can only be loaded into an empty vault");

  const { projects, noteCount } = await seedDemoData();
  return Response.json(
    { projects: projects.map((p) => ({ id: p.id, name: p.name })), noteCount },
    { status: 201 },
  );
}
