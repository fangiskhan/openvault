import { isAuthed } from "@/lib/auth";
import { resolveBearer } from "@/lib/accounts";
import { importSchema } from "@/lib/validation";
import { importProject } from "@/lib/import";
import { prisma } from "@/lib/db";
import { badRequest } from "@/lib/http";

// POST /api/import — create Obsidian-style linked notes (discrete notes + a
// Map-of-Content index + connections) from supplied content. Accepts a human
// session OR an agent bearer token (MCP_TOKEN / approved ovk_ account), so
// import scripts work against a deployed vault, not just localhost. Agents
// connected over MCP should prefer the import_notes tool.
export async function POST(req: Request) {
  const account = await resolveBearer(req);
  if (!account && !(await isAuthed())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = importSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.flatten());

  // replace wipes existing items — reserve it for owner/executive credentials.
  if (parsed.data.replace && !(account && (account.role === "owner" || account.role === "executive")) && !(await isAuthed())) {
    return Response.json({ error: "replace requires owner/executive authority" }, { status: 403 });
  }

  const result = await importProject(parsed.data);
  await prisma.auditEvent.create({
    data: {
      action: "import_notes",
      actor: account?.username ?? "session",
      target: result.projectId,
      detail: `${result.noteCount} notes into "${parsed.data.projectName}"${parsed.data.replace ? " (replace)" : ""}`,
    },
  });
  return Response.json(result, { status: 201 });
}
