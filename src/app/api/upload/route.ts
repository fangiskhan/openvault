import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { saveBlob, safeStorageName } from "@/lib/storage";
import { actorFor } from "@/lib/actor";
import { parseSpreadsheet } from "@/lib/spreadsheet";
import { extractFile, SHEET_EXT } from "@/lib/extract";
import { syncItemLinks } from "@/lib/links";
import { badRequest } from "@/lib/http";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

// Vercel caps a serverless request body at 4.5 MB, well under our own limit —
// so a 10 MB upload fails at the platform before any of this code runs. Said
// here because the resulting error is otherwise unattributable.
const PLATFORM_BODY_LIMIT = 4.5 * 1024 * 1024;

export async function POST(req: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  // Reject oversized bodies before buffering them into memory.
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared && declared > MAX_UPLOAD_BYTES) return badRequest("file too large (max 25 MB)");
  if (declared > PLATFORM_BODY_LIMIT && process.env.VERCEL) {
    return badRequest(
      `file too large for this deployment (${(declared / 1024 / 1024).toFixed(1)} MB) — Vercel caps a request body at 4.5 MB. Self-hosted OpenVault accepts up to 25 MB.`,
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) return badRequest("expected multipart form data");

  const file = form.get("file");
  const projectId = String(form.get("projectId") || "");
  if (!(file instanceof File)) return badRequest("missing file");
  if (!projectId) return badRequest("missing projectId");

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) return badRequest("unknown projectId");

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_UPLOAD_BYTES) return badRequest("file too large (max 25 MB)");
  const isSheet = SHEET_EXT.test(file.name);
  const storageKey = `${projectId}/${Date.now()}-${safeStorageName(file.name)}`;
  await saveBlob(storageKey, buf, file.type || "application/octet-stream");

  let type = "file";
  let body = `Uploaded file **${file.name}**.`;
  let metadata: string | null = null;

  if (isSheet) {
    type = "spreadsheet";
    const sheets = await parseSpreadsheet(file.name, buf);
    metadata = JSON.stringify({ sheets });
    body = `Spreadsheet **${file.name}** — ${sheets.length} sheet(s): ${sheets.map((s) => s.name).join(", ")}.`;
  } else {
    // Everything else goes through text extraction, and the extracted text
    // becomes the item body — which is what search indexes and what an agent
    // reads. A vault that stored the file but indexed only its NAME meant
    // "what did the spec say" returned nothing; the file was in the vault and
    // its contents were not.
    const ex = extractFile(file.name, buf);
    type = ex.kind === "image" ? "image" : ex.kind === "binary" ? "file" : "document";
    metadata = JSON.stringify({ extract: { kind: ex.kind, ...(ex.meta ?? {}) } });
    body = ex.text
      ? `**${file.name}** — extracted text:\n\n${ex.text}`
      : // No text is a fact worth stating, with the reason, so nobody assumes
        // the upload silently failed.
        `**${file.name}** — ${ex.note ?? "no text could be extracted"}.`;
  }

  const by = await actorFor(req);
  const item = await prisma.item.create({
    data: { projectId, type, source: "upload", title: file.name, body, metadata, createdBy: by, updatedBy: by },
  });
  await prisma.fileAsset.create({
    data: {
      projectId,
      itemId: item.id,
      filename: file.name,
      mimeType: file.type || "",
      size: buf.length,
      storageKey,
    },
  });
  await syncItemLinks(item.id, projectId, body);

  return Response.json(item, { status: 201 });
}
