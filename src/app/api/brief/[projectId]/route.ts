import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { resolveBearer } from "@/lib/accounts";
import { secretsRequired } from "@/lib/security";
import { buildTemplatedBriefing } from "@/lib/briefing/templated";
import { ACTIVE_WORK_STATUSES } from "@/lib/code";

// GET /api/brief/[projectId] — the project briefing as PLAIN TEXT, one curl away.
// Built for Claude Code SessionStart hooks: the hook's stdout becomes session
// context, so every agent session starts already knowing the project's state —
// zero tool calls, zero tokens spent querying, no JSON escaping in the hook
// command. Auth: an APP_PASSWORD session, MCP_TOKEN, or an approved account
// token; open only when the server runs open (dev / OPENVAULT_PUBLIC).
export async function GET(req: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const authed = (await isAuthed()) || (await resolveBearer(req)) !== null;
  if (!authed && secretsRequired()) {
    return new Response("unauthorized", { status: 401 });
  }

  const { projectId } = await params;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (!project) return new Response("unknown project", { status: 404 });

  const scope = new URL(req.url).searchParams.get("scope") ?? "connected";
  const [b, work] = await Promise.all([
    buildTemplatedBriefing(projectId, scope),
    prisma.workIntent.findMany({
      where: { projectId, status: { in: [...ACTIVE_WORK_STATUSES] } },
      orderBy: { updatedAt: "desc" },
      take: 10,
    }),
  ]);

  const lines: string[] = [
    `# OpenVault briefing — ${project.name}`,
    `${b.headline.text} (as of ${b.generatedAt})`,
    "",
  ];
  if (b.attention.length) {
    lines.push("## Needs attention");
    for (const a of b.attention) lines.push(`- [${a.label}] ${a.title} — ${a.reason} (item ${a.itemId})`);
    lines.push("");
  }
  if (work.length) {
    lines.push("## Active work (check before editing the same files)");
    for (const w of work) {
      const paths = (JSON.parse(w.paths) as string[]).join(", ");
      lines.push(`- ${w.actor}: ${w.intent} [${w.status}]${paths ? ` — touching: ${paths}` : ""}`);
    }
    lines.push("");
  }
  if (b.recentlyUpdated.length) {
    lines.push("## Recently updated");
    for (const r of b.recentlyUpdated) lines.push(`- ${r.title} (${r.type}, ${r.projectName})`);
    lines.push("");
  }
  lines.push(
    "Use the openvault MCP tools for detail (read_item, get_code_map) and to write back (announce_work before editing, sync_code + update_work in_review when done, append_update to hand over).",
  );

  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
