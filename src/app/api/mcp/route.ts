import crypto from "node:crypto";
import { tools, toolMap, type ToolCtx } from "@/lib/mcp/tools";
import { secretsRequired } from "@/lib/security";
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
async function resolveCaller(req: Request): Promise<ToolCtx | { reject: Response }> {
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const shared = process.env.MCP_TOKEN;

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
          "OpenVault shared project state. Read with get_status / get_attention / get_briefing / read_item / search; write with set_status and append_update so other agents see your changes. Code: announce_work before editing (returns overlap warnings), get_active_work to see who's changing what, sync_code your changed files when done, get_code_map / read_code to browse the shared mirror without pulling git. Merge gate: submit finished work with update_work status=in_review; an owner/executive reviews it with review_work — push to git only after approval.",
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
      try {
        const out = await tool.handler(params?.arguments ?? {}, ctx);
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
