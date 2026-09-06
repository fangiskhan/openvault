// Side-by-side retrieval benchmark: what does it cost, in tokens, to get the
// answer to a real question WITH the vault versus WITHOUT it?
//
//   node scripts/benchmark-retrieval.mjs
//
// WHAT THIS MEASURES, AND WHAT IT DOES NOT
//
// It measures RETRIEVAL cost: the number of tokens that must enter an agent's
// context before it can answer. That is the quantity the README's table claims
// to reduce, it is deterministic, and it is reproducible by anyone with the
// repo. It is NOT an end-to-end agent benchmark — it does not include the
// model's own reasoning tokens or the turns it takes, because measuring those
// honestly needs API-level usage accounting rather than a self-report from an
// agent about its own consumption. That remains future work, and the gap is
// stated in the README rather than papered over.
//
// THE THREE COLUMNS
//
//   vault     search(query) + read_item on each hit the answer actually needs.
//   targeted  The no-vault REALISTIC path, and the one the headline comparison
//             uses: grep the repo for the question's key terms, then read a
//             WINDOW around each hit rather than the whole file. This is what
//             an agent actually does, and it is deliberately the strongest
//             version of the no-vault case. An earlier draft of this script
//             charged the cold path for reading all 30k tokens of tools.ts to
//             answer a question about one tool, which inflated the no-vault
//             side by an order of magnitude and flattered the vault. A
//             benchmark that hands its opponent a strawman measures nothing.
//   whole     The pessimistic no-vault path: same files, read in full. Real
//             when a file is small, wrong when it is not. Reported for
//             contrast, never as the headline.
//
// Tokens are characters / 4 throughout, matching scripts/measure-context.mjs.
//
// COVERAGE, which matters more than the token count
//
// A cheap retrieval that does not contain the answer is not a win, and a
// benchmark that counted only tokens would score it as one. So each question
// carries `mustMention`: terms that any correct answer necessarily contains.
// Each path's retrieved text is checked for them mechanically.
//
// Choosing those terms is the one judgement call left in this script, and it
// is stated rather than hidden. They are deliberately concept markers, not
// phrases lifted from the vault note — "claude-mem" is in the list because no
// answer to "why promote from claude-mem" can avoid naming it, not because the
// note happens to say it.
import { readFileSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const REPO = process.argv[2] ?? process.cwd();
const SKIP = new Set(["node_modules", ".next", ".git", ".vercel", "dist", "build"]);
const SKIP_EXT = /\.(png|jpg|jpeg|webp|gif|ico|woff2?|db|lock)$/i;
const SKIP_FILE = /package-lock\.json$/i;

// ---------------------------------------------------------------- the corpus
//
// The corpus is what GIT TRACKS, not what happens to sit on disk. A plain
// directory walk pulled in two things that wrecked the measurement:
//
//   * tsconfig.tsbuildinfo — a 250 KB build artifact stored as ONE line, so a
//     single grep hit made the "read window" 62,000 tokens on its own, which
//     was most of the cold-path cost in an early run.
//   * this script itself, which contains the search terms it greps for, so the
//     benchmark was partly measuring itself.
//
// Untracked build output is not source an agent would ever read, so git's own
// index is the honest definition of the corpus.
const tracked = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
//   * README.md, for the same reason one level up: it publishes this
//     benchmark's questions, its answer terms AND its results, so grepping the
//     corpus for "claude-mem" found the answer key rather than the source. An
//     audit caught row 1 flipping from "code 1/3" to "code 3/3" purely because
//     the table had been pasted into a file the corpus includes. Excluding the
//     script but not the document that reprints it was half a guard.
const SELF = new Set(["scripts/benchmark-retrieval.mjs", "README.md"]);
const ALL = tracked
  .filter((f) => !SKIP_EXT.test(f) && !SKIP_FILE.test(f) && !SELF.has(f))
  .filter((f) => !f.split("/").some((seg) => SKIP.has(seg)))
  .map((f) => join(REPO, f));
const sizeOf = (p) => (existsSync(p) ? statSync(p).size : 0);
const tok = (chars) => Math.round(chars / 4);
const n = (x) => x.toLocaleString("en-US");

// Grep-then-Read. Returns both what a targeted agent consumes (a window around
// each hit) and what a whole-file reader consumes.
//
// CONTEXT is the half-height of the read window in lines. 40 is generous: it
// is more than Grep's usual -C and enough to swallow a whole tool definition
// or function body in this codebase.
const CONTEXT = 40;
const grepThenRead = (terms) => {
  const files = [];
  let targetedChars = 0;
  let wholeChars = 0;
  let summaryChars = 0;
  let bestWindowChars = 0; // largest single merged window in the most-matched file
  let bestHits = -1;
  const low = terms.map((t) => t.toLowerCase());
  for (const p of ALL) {
    let text;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const hitLines = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      if (low.some((t) => l.includes(t))) hitLines.push(i);
    }
    if (!hitLines.length) continue;
    files.push({ p, hits: hitLines.length });
    wholeChars += text.length;
    // What Grep itself returns: the matching lines, prefixed with file:line.
    for (const i of hitLines) summaryChars += lines[i].length + relative(REPO, p).length + 8;
    // Merge overlapping windows so shared context is not counted twice.
    const merged = [];
    for (const i of hitLines) {
      const from = Math.max(0, i - CONTEXT);
      const to = Math.min(lines.length - 1, i + CONTEXT);
      const last = merged[merged.length - 1];
      if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
      else merged.push([from, to]);
    }
    let biggest = 0;
    for (const [from, to] of merged) {
      let w = 0;
      for (let i = from; i <= to; i++) w += lines[i].length + 1;
      targetedChars += w;
      biggest = Math.max(biggest, w);
    }
    // The file an agent would open first is the one grep hit hardest.
    if (hitLines.length > bestHits) {
      bestHits = hitLines.length;
      bestWindowChars = biggest;
    }
  }
  return { files, targetedChars, wholeChars, summaryChars, bestWindowChars };
};

// ---------------------------------------------------------------- the vault
const server = (() => {
  if (process.env.OV_MCP_URL && process.env.OV_MCP_TOKEN)
    return { url: process.env.OV_MCP_URL, headers: { Authorization: `Bearer ${process.env.OV_MCP_TOKEN}` } };
  const j = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
  const find = (o) => Object.entries(o ?? {}).find(([k]) => k === "openvault-live")?.[1];
  let s = find(j.mcpServers);
  if (!s) for (const c of Object.values(j.projects ?? {})) if ((s = find(c.mcpServers))) break;
  if (!s) throw new Error("set OV_MCP_URL and OV_MCP_TOKEN, or configure the openvault-live MCP server");
  return s;
})();

let rpcId = 1;
const call = async (name, args = {}) => {
  const r = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...server.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const o = await r.json();
  if (o.error) throw new Error(`${name}: ${o.error.message}`);
  return o.result?.content?.[0]?.text ?? "";
};

// ---------------------------------------------------------------- questions
//
// `oracle` lists the files the answer genuinely depends on. For the decision
// questions those are taken from the vault note's OWN citations, which is the
// fairest available source: the note says where in the code it is talking
// about, so the cold path is credited with knowing exactly that much.
const QUESTIONS = [
  {
    id: "claude-mem-why",
    ask: "Why does OpenVault promote from claude-mem instead of capturing sessions automatically?",
    query: "promote from claude-mem capture design automatic session capture rejected",
    terms: ["claude-mem", "claude mem", "promote"],
    mustMention: ["claude-mem", "local", "reject"],
    kind: "decision + rationale",
  },
  {
    id: "claude-mem-how",
    ask: "How is a Claude Code project's history turned into notes?",
    query: "import Claude Code session history into notes one note per session",
    terms: ["import-claude-code", "humanMessages", "importProject"],
    mustMention: ["session", "note", "overview"],
    kind: "implementation",
  },
  {
    id: "never-writes-git",
    ask: "Why does the vault never write to git?",
    query: "why does the vault never write to git replica mode suggestions",
    terms: ["replica", "never writes to git", "mirrorMode"],
    mustMention: ["replica", "suggest", "review"],
    kind: "decision + rationale",
  },
  {
    id: "code-map-shape",
    ask: "What exactly does get_code_map return?",
    query: "get_code_map returns tree of mirrored files hash size ref",
    terms: ["get_code_map"],
    mustMention: ["hash", "size", "path"],
    kind: "implementation (vault expected to LOSE)",
  },
];

// ---------------------------------------------------------------- run
const rows = [];
for (const q of QUESTIONS) {
  const hitsRaw = await call("search", { query: q.query, scope: "all" });
  const hits = JSON.parse(hitsRaw);
  // Take the top hit plus any hit whose title the top note wikilinks to — the
  // "one search plus the notes it cites" path, not "read the whole vault".
  const top = hits[0];
  let vaultChars = hitsRaw.length;
  let vaultBodies = "";
  const read = [];
  if (top) {
    const body = await call("read_item", { itemId: top.id });
    vaultChars += body.length;
    vaultBodies += body;
    read.push(top.title);
    // A note commonly wikilinks the same sibling twice (inline and again under
    // "## Related"). Dedupe, or the benchmark charges the vault twice for one
    // read and quietly understates its own result.
    const seen = new Set([top.title]);
    const linked = [...new Set([...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]))];
    for (const title of linked.slice(0, 2)) {
      if (seen.has(title)) continue;
      const h = hits.find((x) => x.title === title);
      if (!h) continue;
      seen.add(title);
      const b = await call("read_item", { itemId: h.id });
      vaultChars += b.length;
      vaultBodies += b;
      read.push(h.title);
    }
  }

  const g = grepThenRead(q.terms);

  // Coverage: does each path's retrieved text actually contain the answer?
  // The vault side is the text it returned. The cold side is every matching
  // line in the corpus — deliberately generous, since if a term appears
  // nowhere in ANY grep hit, no amount of reading will surface it.
  const vaultText = (hitsRaw + " " + read.join(" ") + " " + vaultBodies).toLowerCase();
  let coldText = "";
  for (const { p } of g.files) {
    try {
      coldText += readFileSync(p, "utf8").toLowerCase();
    } catch {}
  }
  const covers = (text) => q.mustMention.filter((m) => text.includes(m.toLowerCase()));

  rows.push({
    ...q,
    vaultTok: tok(vaultChars),
    // Cold LOWER bound: grep output, plus one read window in the file grep hit
    // hardest — the agent guesses right first time.
    coldMinTok: tok(g.summaryChars + g.bestWindowChars),
    // Cold UPPER bound: grep output, plus a window at every match everywhere.
    coldMaxTok: tok(g.summaryChars + g.targetedChars),
    wholeTok: tok(g.wholeChars),
    fileCount: g.files.length,
    read,
    vaultCovers: covers(vaultText),
    coldCovers: covers(coldText),
  });
}

// ---------------------------------------------------------------- report
console.log(`\nrepo: ${REPO}`);
console.log(`vault: ${server.url}`);
console.log(`method: chars / 4; targeted = grep + read ±${CONTEXT} lines per hit (headline); whole = same files in full\n`);

for (const r of rows) {
  console.log(`## ${r.ask}`);
  console.log(`   kind      : ${r.kind}`);
  console.log(`   vault     : ${String(n(r.vaultTok)).padStart(8)} tok   (${r.read.join(" + ") || "NO HIT"})`);
  console.log(`   cold min  : ${String(n(r.coldMinTok)).padStart(8)} tok   grep + 1 window (agent guesses right)`);
  console.log(`   cold max  : ${String(n(r.coldMaxTok)).padStart(8)} tok   grep + every window, ${r.fileCount} files`);
  console.log(`   cold whole: ${String(n(r.wholeTok)).padStart(8)} tok   those files read in full`);
  const need = r.mustMention.length;
  console.log(`   coverage  : vault ${r.vaultCovers.length}/${need} [${r.vaultCovers.join(", ") || "-"}]   cold ${r.coldCovers.length}/${need} [${r.coldCovers.join(", ") || "-"}]`);
  const lo = r.coldMinTok / r.vaultTok;
  const hi = r.coldMaxTok / r.vaultTok;
  const say = (x) => (x >= 1 ? `${x.toFixed(1)}x cheaper WITH vault` : `${(1 / x).toFixed(1)}x cheaper WITHOUT`);
  console.log(`   verdict   : ${say(lo)} (best case for cold) .. ${say(hi)} (worst)`);
  console.log();
}

console.log("| Question | With vault | Without (best..worst) | Answer present? |");
console.log("| --- | --- | --- | --- |");
for (const r of rows) {
  const need = r.mustMention.length;
  const v = `${r.vaultCovers.length}/${need}`;
  const c = `${r.coldCovers.length}/${need}`;
  console.log(
    `| ${r.ask} | ${n(r.vaultTok)} | ${n(r.coldMinTok)} .. ${n(r.coldMaxTok)} | vault ${v}, code ${c} |`,
  );
}
console.log();
