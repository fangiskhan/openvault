// Re-measure the context-cost table in the README.
//
//   node scripts/measure-context.mjs [projectName] [baseUrl]
//
// The numbers in that table were originally taken by hand, which is why they
// went stale the moment the vault grew. This makes them reproducible: run it,
// paste the table.
//
// METHOD, stated so the numbers mean something:
//   * Tokens are estimated as characters / 4. No tokenizer is a dependency of
//     this project and adding one to print a marketing table is not worth the
//     install. The ratio between two figures — which is the actual claim — is
//     insensitive to the constant anyway.
//   * Every figure is the payload an agent actually receives: the MCP tool
//     result text, over HTTP, against the live vault.
//   * The "read the mirror" figure is the sum of every mirrored file's stored
//     size, from get_code_map's own metadata. That UNDER-states the real cost,
//     since read_code also carries per-call JSON envelope and headers, so the
//     comparison is conservative in the vault's disfavour.
//
// Auth: OV_MCP_URL + OV_MCP_TOKEN if set, else the openvault-live entry in
// ~/.claude.json. The token is never printed.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT = process.argv[2] ?? "OpenVault";

const resolveServer = () => {
  if (process.env.OV_MCP_URL && process.env.OV_MCP_TOKEN) {
    return { url: process.env.OV_MCP_URL, headers: { Authorization: `Bearer ${process.env.OV_MCP_TOKEN}` } };
  }
  const f = join(homedir(), ".claude.json");
  if (!existsSync(f)) throw new Error("set OV_MCP_URL and OV_MCP_TOKEN, or configure the openvault-live MCP server");
  const j = JSON.parse(readFileSync(f, "utf8"));
  const find = (o) => Object.entries(o ?? {}).find(([k]) => k === "openvault-live")?.[1];
  let s = find(j.mcpServers);
  if (!s) for (const c of Object.values(j.projects ?? {})) if ((s = find(c.mcpServers))) break;
  if (!s) throw new Error("no openvault-live MCP server configured");
  return s;
};
const server = process.argv[3] ? { url: process.argv[3], headers: resolveServer().headers } : resolveServer();

let id = 1;
const rpc = async (method, params) => {
  const r = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...server.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method} ${JSON.stringify(params?.name ?? "")}: ${j.error.message}`);
  return j.result;
};
const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).content?.[0]?.text ?? "";

const tok = (s) => Math.round(s.length / 4);
const n = (x) => x.toLocaleString("en-US");

// --- resolve the project -----------------------------------------------------
const projects = JSON.parse(await call("list_projects"));
const project = projects.find((p) => p.name.toLowerCase() === PROJECT.toLowerCase()) ??
  projects.find((p) => p.name.toLowerCase().includes(PROJECT.toLowerCase()));
if (!project) throw new Error(`no project matching "${PROJECT}" (have: ${projects.map((p) => p.name).join(", ")})`);
const projectId = project.id;

// --- the rows ----------------------------------------------------------------
const briefing = await call("get_briefing", { projectId });
const codeMap = await call("get_code_map", { projectId });
const activity = await call("get_recent_activity", { projectId, sinceHours: 168 });

// One question answered from the vault: a search, then the note it cites.
const QUESTION = process.env.OV_QUESTION ?? "why does the vault never write to git";
const hits = await call("search", { query: QUESTION, projectId, scope: "all" });
const firstHit = JSON.parse(hits)[0];
const note = firstHit ? await call("read_item", { itemId: firstHit.id }) : "";

// Whole-mirror cost, from the map's own size metadata.
const map = JSON.parse(codeMap);
const files = map.files ?? map.tree ?? [];
const mirrorChars = files.reduce((sum, f) => sum + (f.size ?? 0), 0);

// Session overhead: every tool schema is loaded at connect time, whether used
// or not. The README quoted "~30 tools" and there are rather more now.
const tools = (await rpc("tools/list", {})).tools ?? [];
const schemaChars = JSON.stringify(tools).length;

// --- report ------------------------------------------------------------------
const rows = [
  ["get_briefing", tok(briefing), `${n(briefing.length)} chars`],
  ["get_code_map", tok(codeMap), `${n(files.length)} files`],
  ["read the whole mirror", Math.round(mirrorChars / 4), `${n(mirrorChars)} chars of source`],
  ["get_recent_activity (7d)", tok(activity), "sinceHours: 168"],
  ["search + read_item", tok(hits) + tok(note), `"${QUESTION}" -> ${firstHit?.title ?? "(no hit)"}`],
  ["tool schemas at connect", Math.round(schemaChars / 4), `${tools.length} tools`],
];

console.log(`\nvault: ${server.url}`);
console.log(`project: ${project.name} (${projectId})`);
console.log(`method: chars / 4\n`);
const w = Math.max(...rows.map((r) => r[0].length));
for (const [label, tokens, note_] of rows) {
  console.log(`  ${label.padEnd(w)}  ${String(n(tokens)).padStart(8)} tok   ${note_}`);
}
const ratio = mirrorChars / 4 / tok(codeMap);
console.log(`\n  code map vs whole mirror: ${ratio.toFixed(1)}x cheaper`);
console.log();
