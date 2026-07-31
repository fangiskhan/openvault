import crypto from "node:crypto";
import { tools, toolMap, type ToolCtx } from "@/lib/mcp/tools";
import { secretsRequired, isDemoMode } from "@/lib/security";
import { resolveByToken, getOrCreateOwner } from "@/lib/accounts";
import { rateLimit, clientKey } from "@/lib/ratelimit";

// Constant-time string compare so the shared-token check can't be probed byte
// by byte via response timing. Bails on length mismatch (that much is public).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Minimal MCP server over JSON-RPC 2.0 (Streamable HTTP, single-response mode).
// Any MCP client — Claude Code, Cursor, Codex — connects here to read and write
// shared project state, so agents stay coordinated without a human handover.

const PROTOCOL_VERSION = "2025-06-18";

// Resolve the caller's identity from the bearer token:
//  - the shared MCP_TOKEN (legacy/bootstrap key) → the root owner account
//  - a per-account token → that account (must be approved; pending/revoked rejected)
// Returns a ToolCtx (account, possibly null in open dev) used to attribute every
// write to the real person, or a `reject` Response. An empty MCP_TOKEN is only
// allowed when running open (dev / OPENVAULT_PUBLIC=1); assertSecureBoot stops a
// production server with no token, this is the request-time backstop.
// Tools that only read. In demo mode everything else is refused, so a visitor
// can point a real agent at the demo and explore the vault, but cannot alter
// it. An allowlist rather than a blocklist: a new tool is denied until someone
// deliberately declares it safe.
const DEMO_READ_TOOLS = new Set([
  "whoami", "list_projects", "get_status", "get_attention", "get_briefing",
  "get_recent_activity", "search", "read_item", "get_inbox",
  "get_graph", "get_links", "find_path", "suggest_links", "find_project_bridges",
  "get_active_work", "get_code_map", "read_code",
  "list_skills", "get_skill", "find_mcp",
]);

async function resolveCaller(req: Request): Promise<ToolCtx | { reject: Response }> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const shared = process.env.MCP_TOKEN;

  // Demo mode: connect without credentials, read-only (enforced per tool below).
  if (isDemoMode() && !bearer) return { account: null };

  if (shared && bearer && safeEqual(bearer, shared)) {
    const owner = await getOrCreateOwner();
    return { account: { id: owner.id, username: owner.username, role: owner.role, status: owner.status } };
  }
  if (bearer) {
    const acc = await resolveByToken(bearer);
    if (!acc) return { reject: error(null, -32001, "unknown token", 401) };
    if (acc.status !== "approved") {
      return { reject: error(null, -32001, `account '${acc.username}' is ${acc.status} — an owner/executive must approve it`, 403) };
    }
    return { account: { id: acc.id, username: acc.username, role: acc.role, status: acc.status } };
  }
  // No bearer presented.
  if (!shared) {
    if (secretsRequired()) return { reject: error(null, -32001, "server misconfigured: MCP_TOKEN is not set", 503) };
    return { account: null }; // open local/dev
  }
  return { reject: error(null, -32001, "unauthorized", 401) };
}

function result(id: unknown, value: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result: value });
}
function error(id: unknown, code: number, message: string, status = 200) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

type RpcMessage = {
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};

export async function POST(req: Request) {
  // Generous — a busy agent makes bursts of calls — but bounds runaway loops
  // and unauthenticated probing alike.
  if (!rateLimit(`mcp:${clientKey(req)}`, 300, 60_000)) {
    return error(null, -32000, "rate limited: over 300 requests/minute", 429);
  }
  const caller = await resolveCaller(req);
  if ("reject" in caller) return caller.reject;
  const ctx: ToolCtx = caller;

  let msg: RpcMessage;
  try {
    msg = await req.json();
  } catch {
    return error(null, -32700, "parse error");
  }

  const { id, method, params } = msg ?? {};

  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "openvault", version: "0.1.0" },
        instructions:
          "OpenVault is this user's source of truth for ALL their projects (code, decisions, history, status). BEFORE asking the user about any past project, decision, codebase detail, or 'what did we do about X' — search this vault first (search / get_briefing / read_item); the answer is usually already recorded, and asking the user wastes their time and your tokens. Read with get_status / get_attention / get_briefing / get_recent_activity / read_item / search; write with set_status and append_update so other agents see your changes. Code: announce_work before editing (returns overlap warnings), get_active_work to see who's changing what, get_code_map / read_code to browse the shared mirror without pulling git. SUGGEST, DON'T FIX: on any project where you cannot push (no git access, or a replica-mode mirror), your deliverable IS a suggestion in the queue — not a note describing the fix, not prose telling the owner what to run, not an explanation of what you would do if you could. If you catch yourself writing 'the owner should change X to Y' anywhere outside suggest_change, stop and file it: anchored edits for changes, before:'' parts for a NEW file (several parts for a big one), deleteFile:true to propose removing one; every proposal needs a reason, which becomes a note that outlives the review. Work the owner must reconstruct from prose is undelivered work. SHARED FILES: list_files shows a project's uploads and read_file returns a document's extracted text or an image you can look at; uploads are searchable by their content. An asset that belongs in a repo (wallpaper, logo, font) must be FETCHED, never retyped — GET read_file's downloadPath from this vault with your token and write the bytes; binaries cannot travel through suggest_change, so download the asset and propose only the code that references it. Check list_suggestions for the project's open queue — review pending proposals if you are the owner's agent (review_suggestion), and don't re-file what's already proposed. withdraw_suggestion takes back your own open proposal. Approval never touches git: the owner applies the result in their own checkout and CI mirrors it. sync_code writes the mirror directly ONLY on workspace-mode projects — always pass baseHash. Merge gate: submit finished work with update_work status=in_review; an owner/executive reviews it with review_work — push to git only after approval. Call list_skills when you start on a project and follow the ones that apply — they are that team's conventions, and set_skill records a new one so the next agent inherits it. If a search finds nothing, say the vault has no record rather than guessing. WRITE BACK, unasked, whatever the next session would otherwise rediscover: decisions with their reasoning (and what was rejected), gotchas with symptom+cause+fix, how a subsystem works once you've read it, measured numbers instead of adjectives, and anything the user corrected you about. Use import_notes for atomic notes (one idea each, specific searchable titles, [[wikilinks]] between them, bodies that stand alone — re-importing a title UPDATES that note) or append_update for a progress line; a wrong note can be retracted with delete_item (owner/executive), which audits who removed what and why.",
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return new Response(null, { status: 202 });

    case "ping":
      return result(id, {});

    case "tools/list":
      return result(id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });

    case "tools/call": {
      const tool = params?.name ? toolMap.get(params.name) : undefined;
      if (!tool) return error(id, -32602, `unknown tool: ${params?.name}`);
      if (isDemoMode() && !DEMO_READ_TOOLS.has(tool.name)) {
        return result(id, {
          content: [
            {
              type: "text",
              text: `Error: '${tool.name}' writes, and this is a public read-only demo of OpenVault. Read tools all work — try get_briefing, search, get_graph or get_code_map. Self-host for a writable vault: https://github.com/fangiskhan/openvault`,
            },
          ],
          isError: true,
        });
      }
      // Enforce each tool's declared required arguments. Without this, a
      // malformed call (e.g. `q` instead of `query`) reaches the handler as
      // undefined and can return a plausible empty result — the agent then
      // concludes "the vault has nothing" instead of fixing its call.
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const required = ((tool.inputSchema as { required?: string[] }).required ?? []).filter(
        (k) => args[k] === undefined,
      );
      if (required.length) {
        return result(id, {
          content: [{ type: "text", text: `Error: missing required argument(s): ${required.join(", ")}` }],
          isError: true,
        });
      }
      try {
        const out = await tool.handler(args, ctx);
        // Most tools return data, which is serialised as one text block. A tool
        // may instead return ready-made MCP content blocks — the only way to
        // hand an agent an IMAGE it can actually look at, rather than a
        // paragraph describing one.
        if (out && typeof out === "object" && Array.isArray((out as { _mcpContent?: unknown[] })._mcpContent)) {
          return result(id, { content: (out as { _mcpContent: unknown[] })._mcpContent });
        }
        return result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return result(id, {
          content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
          isError: true,
        });
      }
    }

    default:
      return error(id, -32601, `method not found: ${method}`);
  }
}

// Friendly hint for clients that probe with GET.
export function GET() {
  return Response.json({ name: "openvault-mcp", transport: "streamable-http", hint: "POST JSON-RPC 2.0 here" });
}
