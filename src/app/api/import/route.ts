import { requireAuth } from "@/lib/auth";
import { importSchema } from "@/lib/validation";
import { importProject } from "@/lib/import";
import { badRequest } from "@/lib/http";

// POST /api/import — create Obsidian-style linked notes (discrete notes + a
// Map-of-Content index + connections) from supplied content. Used by the
// Claude Code importer and available to agents over the API.
export async function POST(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  const parsed = importSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.flatten());

  const result = await importProject(parsed.data);
  return Response.json(result, { status: 201 });
}
