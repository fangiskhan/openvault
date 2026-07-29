import { z } from "zod";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { resolveBearer } from "@/lib/accounts";
import { secretsRequired } from "@/lib/security";
import { isValidRepoPath, normalizeRepoPath } from "@/lib/code";
import { badRequest } from "@/lib/http";
import { rateLimit, clientKey, tooMany } from "@/lib/ratelimit";

// POST /api/activity — automatic capture from a PostToolUse hook.
//
// The vault's memory otherwise depends on an agent CHOOSING to write a note,
// which is a habit, not a guarantee. This records the factual trail — who
// touched which file, with which tool, when — so a session leaves evidence
// even when nobody writes prose. Deliberately narrow: filenames and tool
// names, never file contents or command output, so a shared vault does not
// become an exfiltration channel for whatever an agent happened to read.
//
// Stored as AuditEvent rows: append-only by design, already surfaced by
// get_recent_activity, and no new table to back up.
const schema = z.object({
  projectId: z.string().min(1),
  tool: z.string().max(60).optional(),
  file: z.string().max(400).optional(),
  actor: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  // A busy session fires this constantly; the cap keeps a runaway loop from
  // filling the audit log.
  if (!rateLimit(`activity:${clientKey(req)}`, 600, 60_000)) return tooMany("too many activity events");

  const account = await resolveBearer(req);
  if (!account && secretsRequired() && !(await isAuthed())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.flatten());
  const { projectId, tool, file } = parsed.data;

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return badRequest("unknown projectId");

  // Only repo-relative paths are stored. An absolute path pins one laptop's
  // directory layout into a shared vault and never matches the code mirror,
  // whose paths come from `git ls-files` — so it is worse than no row at all.
  // This also catches a hook that posted an unexpanded shell variable or an
  // empty string, which is how the original curl-based hook failed: it recorded
  // nothing while the server kept answering 200. The reason is echoed back so a
  // misconfigured hook is diagnosable instead of merely quiet.
  const raw = file?.trim() ?? "";
  const candidate = raw ? normalizeRepoPath(raw) : "";
  if (!candidate) return Response.json({ ok: true, skipped: "no file path" });
  if (!isValidRepoPath(candidate)) {
    return Response.json({ ok: true, skipped: "not a repo-relative path", got: candidate.slice(0, 120) });
  }
  const path = candidate;
  const toolName = tool?.trim() && !tool.startsWith("$") ? tool.trim() : "edit";

  const by = account?.username ?? parsed.data.actor ?? "session";

  // One row per file per actor per hour: a session editing the same file forty
  // times is one fact, not forty. Keeps the trail readable and the log small.
  const hourAgo = new Date(Date.now() - 3_600_000);
  const recent = await prisma.auditEvent.findFirst({
    where: { action: "touched", actor: by, target: projectId, detail: path, createdAt: { gte: hourAgo } },
    select: { id: true },
  });
  if (recent) return Response.json({ ok: true, deduped: true });

  await prisma.auditEvent.create({
    data: { action: "touched", actor: by, target: projectId, detail: path },
  });
  return Response.json({ ok: true, recorded: { file: path, tool: toolName, by } });
}
