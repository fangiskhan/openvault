import { promises as fs } from "node:fs";
import path from "node:path";

// Blob storage adapter. Local disk for self-host/your-own-PC; Vercel Blob for
// the cloud (Vercel has no persistent disk). Returns a stable storageKey.
const ROOT = path.join(process.cwd(), "storage");

export async function saveBlob(key: string, data: Buffer, contentType: string): Promise<void> {
  if (process.env.STORAGE_DRIVER === "vercel") {
    // Requires `npm i @vercel/blob` and BLOB_READ_WRITE_TOKEN in the env.
    const { put } = await import("@vercel/blob").catch(() => {
      throw new Error("STORAGE_DRIVER=vercel requires the @vercel/blob package");
    });
    await put(key, data, {
      access: "public",
      contentType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
    });
    return;
  }
  const full = path.join(ROOT, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

export async function readBlob(key: string): Promise<Buffer> {
  const full = path.join(ROOT, key);
  return fs.readFile(full);
}
