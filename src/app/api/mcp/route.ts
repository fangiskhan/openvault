import { tools, toolMap } from "@/lib/mcp/tools";

// Minimal MCP server over JSON-RPC 2.0 (Streamable HTTP, single-response mode).
// Any MCP client — Claude Code, Cursor, Codex — connects here to read and write
// shared project state, so agents stay coordinated without a human handover.

const PROTOCOL_VERSION = "2025-06-18";

// Auth: a static bearer token for agents, separate from the human session.
// Empty MCP_TOKEN = open (fine for purely local use).
function authOk(req: Request): boolean {
  const token = process.env.MCP_TOKEN;
  if (!token) return true;
  return (req.headers.get("authorization") || "") === `Bearer ${token}`;
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
  if (!authOk(req)) return error(null, -32001, "unauthorized", 401);

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
          "OpenVault shared project state. Read with get_status / get_attention / get_briefing / read_item / search; write with set_status and append_update so other agents see your changes.",
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
        const out = await tool.handler(params?.arguments ?? {});
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
