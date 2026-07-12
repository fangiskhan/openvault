import { z } from "zod";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { resolveBearer } from "@/lib/accounts";
import { secretsRequired } from "@/lib/security";
import { syncItemLinks } from "@/lib/links";
import { ITEM_TYPES, SOURCES } from "@/lib/validation";
import { badRequest } from "@/lib/http";
import { rateLimit, clientKey, tooMany } from "@/lib/ratelimit";

const ingestSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  body: z.string().max(1_000_000).optional(),
  type: z.enum(ITEM_TYPES).optional(), // default "message" — most webhook payloads are updates/comments
  source: z.enum(SOURCES).optional(),
  sourceRef: z.string().max(500).optional(), // external id/url — same ref updates instead of duplicating
  actor: z.string().max(120).optional(),
});

// POST /api/ingest — the integration foundation. Anything that can send an HTTP
// POST (Jira automation, Slack workflow, GitHub Action, Zapier/n8n, a cron
// script) can push content into a project. Upserts by (projectId, sourceRef) so
// an edited comment updates its item instead of piling up duplicates.
// Auth: MCP_TOKEN or an approved account bearer (open only in dev/public mode).
export async function POST(req: Request) {
  if (!rateLimit(`ingest:${clientKey(req)}`, 120, 60_000)) return tooMany("over 120 ingests/minute");

  const account = await resolveBearer(req);
  if (!account && secretsRequired() && !(await isAuthed())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = ingestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.flatten());
  const { projectId, title, body, type, source, sourceRef, actor } = parsed.data;

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return badRequest("unknown projectId");

  const by = account?.username ?? actor ?? "webhook";
  const data = {
    title,
    body: body ?? "",
    type: type ?? "message",
    source: source ?? "local",
    sourceRef: sourceRef ?? null,
    metadata: JSON.stringify({ ingestedBy: by }),
  };

  const existing = sourceRef
    ? await prisma.item.findFirst({ where: { projectId, sourceRef }, select: { id: true } })
    : null;
  const item = existing
    ? await prisma.item.update({ where: { id: existing.id }, data })
    : await prisma.item.create({ data: { projectId, ...data } });

  await syncItemLinks(item.id, projectId, item.body);
  await prisma.auditEvent.create({
    data: { action: "ingest", actor: by, target: projectId, detail: `${existing ? "updated" : "created"} "${title.slice(0, 80)}"` },
  });

  return Response.json({ itemId: item.id, updated: !!existing }, { status: existing ? 200 : 201 });
}
