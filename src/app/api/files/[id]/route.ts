import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { resolveBearer } from "@/lib/accounts";
import { secretsRequired } from "@/lib/security";
import { readBlob } from "@/lib/storage";
import { notFound } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/files/[id] — hand an uploaded file back.
//
// The vault could take files and never return one: 28 API routes and not a
// single reader, so an upload was a one-way trip. Serving by FileAsset id
// rather than by storage key means the path on disk is never part of the URL,
// so no request can ask for a file the database does not list.
//
// Accepts an account bearer token as well as a browser session. Without that
// an AGENT could see an image through read_file but never fetch the bytes —
// which is the whole point when the file is an asset that has to end up in
// someone's repository.
export async function GET(req: Request, { params }: Ctx) {
  const authed = (await isAuthed()) || (await resolveBearer(req)) !== null;
  if (!authed && secretsRequired()) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const asset = await prisma.fileAsset.findUnique({
    where: { id },
    select: { filename: true, mimeType: true, size: true, storageKey: true },
  });
  if (!asset) return notFound();

  let data: Buffer;
  try {
    data = await readBlob(asset.storageKey);
  } catch {
    // The row exists but the bytes do not — a restored database without its
    // storage directory, or a blob deleted out from under us. Say which.
    return new Response(`stored file is missing (${asset.storageKey})`, { status: 410 });
  }

  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": asset.mimeType || "application/octet-stream",
      "content-length": String(data.length),
      // inline: images and PDFs preview in the browser; everything else is
      // still downloadable. The filename is quoted and its quotes stripped so
      // it cannot break out of the header.
      "content-disposition": `inline; filename="${asset.filename.replace(/["\r\n]/g, "")}"`,
      "cache-control": "private, max-age=300",
    },
  });
}
