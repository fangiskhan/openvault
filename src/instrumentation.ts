import { assertSecureBoot } from "@/lib/security";

// register() runs once when a Next.js server instance boots, before it serves
// any requests. We use it to fail fast: a production deploy with open auth gates
// (empty APP_PASSWORD / MCP_TOKEN) refuses to start rather than silently exposing
// the human UI and the agent MCP write endpoint. See src/lib/security.ts.
export function register() {
  // Skip the edge runtime — the app's server and routes run on Node, and
  // throwing in the edge instance would only confuse the boot diagnostics.
  if (process.env.NEXT_RUNTIME !== "edge") {
    assertSecureBoot();
  }
}
