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

  const { projectId: key } = await params;
  // Accept a SLUG as well as an id. A .claude/settings.json committed to a repo
  // has to work in someone else's clone, where the cuid differs but the slug is
  // the same; both columns are @unique, so the fallback cannot be ambiguous.
  const project =
    (await prisma.project.findUnique({ where: { id: key }, select: { id: true, name: true } })) ??
    (await prisma.project.findUnique({ where: { slug: key }, select: { id: true, name: true } }));
  if (!project) return new Response("unknown project", { status: 404 });
  const projectId = project.id;

  const scope = new URL(req.url).searchParams.get("scope") ?? "connected";
  const [b, work, skills, suggestions] = await Promise.all([
    buildTemplatedBriefing(projectId, scope),
    prisma.workIntent.findMany({
      where: { projectId, status: { in: [...ACTIVE_WORK_STATUSES] } },
      orderBy: { updatedAt: "desc" },
      take: 10,
    }),
    prisma.projectSkill.findMany({
      where: { projectId },
      orderBy: { name: "asc" },
      select: { name: true, description: true },
    }),
    // Proposed code changes waiting on a human verdict. Surfaced HERE because a
    // proposal nobody sees is a proposal that never happened — the owner's
    // agent must meet the queue at session start, not after thinking to ask.
    prisma.codeSuggestion.findMany({
      where: { projectId, status: "open" },
      // Oldest first: the one that has waited longest is the one someone has
      // been blocked on longest, and it must not be pushed off by newer ones.
      orderBy: { createdAt: "asc" },
      take: 10,
      select: { id: true, path: true, title: true, suggestedBy: true, createdAt: true },
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
  if (suggestions.length) {
    lines.push(`## Open code suggestions — ${suggestions.length} awaiting review`);
    for (const s of suggestions) {
      const days = Math.floor((Date.now() - s.createdAt.getTime()) / 86_400_000);
      const waited = days >= 1 ? ` — waiting ${days} day${days === 1 ? "" : "s"}` : "";
      lines.push(`- ${s.title ?? s.path} — by ${s.suggestedBy}${waited} (${s.id})`);
    }
    lines.push("(get_suggestion for the edits; review_suggestion to approve/reject if you act for an owner/executive)");
    lines.push("");
  }
  if (b.recentlyUpdated.length) {
    lines.push("## Recently updated");
    for (const r of b.recentlyUpdated) lines.push(`- ${r.title} (${r.type}, ${r.projectName})`);
    lines.push("");
  }
  if (skills.length) {
    // The project's own rules, injected before the agent does anything — the
    // whole point of storing skills on the project rather than each machine.
    lines.push("## This project's skills — follow these, they are the team's conventions");
    for (const s of skills) lines.push(`- ${s.name}: ${s.description}`);
    lines.push(`(call get_skill with projectId ${project.id} and the name for full instructions)`);
    lines.push("");
  }
  lines.push(
    "Use the openvault MCP tools for detail (read_item, get_code_map) and to write back (announce_work before editing, append_update to hand over). To change code you cannot push: suggest_change — anchored edits, before:'' parts for a new file, deleteFile:true to propose removing one; withdraw_suggestion takes back your own open proposal.",
  );

  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
