import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import path from "node:path";

// The db storage driver, which is what a serverless deployment uses: its
// filesystem is read-only, so the local-disk driver cannot work there and
// uploads failed with an unexplained 500. Exercised against a throwaway
// SQLite file, never dev.db.
const TEST_DB = path.join(process.cwd(), "prisma", "storage-test.db");
process.env.DATABASE_URL = `file:./storage-test.db`;
process.env.STORAGE_DRIVER = "db";

let storage: typeof import("./storage");
let prisma: (typeof import("./db"))["prisma"];

beforeAll(async () => {
  try {
    unlinkSync(TEST_DB);
  } catch {
    /* first run */
  }
  execSync("npx prisma db push --skip-generate", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:./storage-test.db` },
    stdio: "pipe",
  });
  storage = await import("./storage");
  ({ prisma } = await import("./db"));
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    unlinkSync(TEST_DB);
  } catch {
    /* windows may hold the handle briefly */
  }
});

describe("db storage driver", () => {
  it("chooses itself on a serverless host, where local disk cannot work", () => {
    const prev = process.env.STORAGE_DRIVER;
    delete process.env.STORAGE_DRIVER;
    process.env.VERCEL = "1";
    expect(storage.storageDriver()).toBe("db");
    delete process.env.VERCEL;
    expect(storage.storageDriver()).toBe("local");
    process.env.STORAGE_DRIVER = prev;
  });

  it("round-trips bytes exactly, including binary that is not valid UTF-8", async () => {
    const project = await prisma.project.create({ data: { name: "S", slug: "s-" + Date.now() } });
    // 0xFF 0xFE is not valid UTF-8 — a base64/string round trip would corrupt
    // it, which is why the column is Bytes.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
    const key = `${project.id}/binary.png`;
    await storage.saveBlob(key, bytes, "image/png");
    await prisma.fileAsset.create({
      data: { projectId: project.id, filename: "binary.png", mimeType: "image/png", size: bytes.length, storageKey: key, data: bytes },
    });
    const back = await storage.readBlob(key);
    expect(Buffer.compare(back, bytes)).toBe(0);
    await prisma.project.delete({ where: { id: project.id } });
  });

  it("refuses a file past the cap, naming the limit and the way around it", async () => {
    const big = Buffer.alloc(storage.DB_BLOB_MAX_BYTES + 1);
    await expect(storage.saveBlob("k", big, "application/octet-stream")).rejects.toThrow(/stores files in the database up to/);
  });

  it("reports a missing blob rather than returning empty bytes", async () => {
    await expect(storage.readBlob("nope/missing.txt")).rejects.toThrow(/no stored bytes/);
  });
});
