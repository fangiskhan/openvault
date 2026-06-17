// Import a Claude Code project's history into OpenVault as Obsidian-style notes:
// one note per session + a Map-of-Content "overview" that wikilinks them
// (and the codebase map, if one exists). A real, reusable tool — not a one-off.
//
// Usage:
//   npx tsx scripts/import-claude-code.ts <claudeProjectDir> <DisplayName> [connectCsv]
// Example:
//   npx tsx scripts/import-claude-code.ts "C:\Users\me\.claude\projects\D--Bots-Lumina" "Lumina" "ace,video-overlay"
import { importProject, type ImportNote } from "../src/lib/import";
import { prisma } from "../src/lib/db";
import fs from "node:fs";
import path from "node:path";

const RECENT = 6;
const MAX_MSG = 500;
const MAX_NOTE = 40_000;

function humanMessages(file: string): string[] {
  const out: string[] = [];
  let data: string;
  try {
    data = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of data.split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    let o: { type?: string; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "user" || !o.message) continue;
    const c = o.message.content;
    let text: string | null = null;
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      if (c.some((b) => (b as { type?: string }).type === "tool_result")) continue;
      const parts = c.filter((b) => (b as { type?: string }).type === "text").map((b) => (b as { text: string }).text);
      if (parts.length) text = parts.join(" ");
    }
    if (!text) continue;
    text = text.replace(/\s+/g, " ").trim();
    if (!text || text.startsWith("<")) continue;
    if (text.length > MAX_MSG) text = text.slice(0, MAX_MSG) + "…";
    out.push(text);
  }
  return out;
}

async function main() {
  const dir = process.argv[2];
  const name = process.argv[3];
  const connectTo = (process.argv[4] ? process.argv[4].split(",") : []).map((s) => s.trim()).filter(Boolean);
  if (!dir || !name) {
    console.error("usage: import-claude-code <claudeProjectDir> <DisplayName> [connectCsv]");
    process.exit(1);
  }
  if (!fs.existsSync(dir)) {
    console.error("no such dir: " + dir);
    process.exit(1);
  }

  // Preserve an existing codebase-map note across the re-import.
  const proj = await prisma.project.findFirst({ where: { name } });
  let codemap: ImportNote | null = null;
  if (proj) {
    const cm = await prisma.item.findFirst({ where: { projectId: proj.id, title: `${name} — codebase map` } });
    if (cm) codemap = { title: cm.title, body: cm.body, type: "note" };
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, RECENT)
    .reverse();

  const notes: ImportNote[] = [];
  let idx = 1;
  for (const { f, t } of files) {
    const msgs = humanMessages(path.join(dir, f));
    if (!msgs.length) {
      idx++;
      continue;
    }
    const date = new Date(t).toISOString().slice(0, 10);
    const title = `${name} — session ${idx} (${date})`;
    let body = `# ${title}\n\nYour messages this session:\n\n` + msgs.map((m) => `- ${m}`).join("\n");
    if (body.length > MAX_NOTE) body = body.slice(0, MAX_NOTE) + "\n…(trimmed)";
    notes.push({ title, body, type: "note" });
    idx++;
  }
  if (codemap) notes.push(codemap);

  const res = await importProject({
    projectName: name,
    color: "#6aa3ff",
    notes,
    mocTitle: `${name} — overview`,
    connectTo,
    replace: true,
  });
  console.log(`Imported ${name}: ${res.noteCount} notes (incl. overview)` + (connectTo.length ? ` · connected to ${connectTo.join(", ")}` : ""));
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
