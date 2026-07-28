import { spawnSync } from "node:child_process";

// Pushes the generated Postgres schema during a deploy.
//
// `prisma db push` refuses changes it considers lossy (dropping a column,
// replacing a unique index) unless forced. That refusal is a FEATURE here: a
// failed deploy is how a destructive schema change gets noticed before it runs
// against real data, so --accept-data-loss must never be baked into the build.
//
// When a change genuinely is safe — verified by looking at what is stored —
// set PRISMA_ACCEPT_DATA_LOSS=1 in the deploy environment for that one deploy,
// then remove it. Explicit, visible in the env, and off again by default.
const accept = process.env.PRISMA_ACCEPT_DATA_LOSS === "1";
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!url) {
  console.error("No DATABASE_URL / DATABASE_URL_UNPOOLED in the build environment.");
  process.exit(1);
}
if (accept) {
  console.warn("PRISMA_ACCEPT_DATA_LOSS=1 — applying a schema change that Prisma flagged as lossy. Unset this after the deploy.");
}

const args = ["prisma", "db", "push", "--schema", "prisma/schema.postgres.prisma", "--skip-generate"];
if (accept) args.push("--accept-data-loss");

// DDL runs over the unpooled connection; poolers reject some statements.
const res = spawnSync("npx", args, { stdio: "inherit", shell: true, env: { ...process.env, DATABASE_URL: url } });
process.exit(res.status ?? 1);
