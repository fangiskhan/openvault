// Generates prisma/schema.postgres.prisma from the canonical SQLite schema by
// swapping the datasource provider. Prisma can't switch providers via env, so
// deploys generate this file at build time (see "vercel-build") — one source of
// truth, zero drift. The generated file is gitignored.
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("prisma/schema.prisma", "utf8");
if (!src.includes('provider = "sqlite"')) {
  console.error("schema.prisma is not on the sqlite provider — refusing to generate");
  process.exit(1);
}
const out = src.replace('provider = "sqlite"', 'provider = "postgresql"');
writeFileSync("prisma/schema.postgres.prisma", out);
console.log("wrote prisma/schema.postgres.prisma (provider=postgresql)");
