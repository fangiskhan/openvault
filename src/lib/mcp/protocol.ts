// MCP protocol version negotiation.
//
// The spec says a server should ECHO the client's requested version when it
// supports it, and fall back to its own only when it does not. Returning ours
// unconditionally -- which a hardcoded constant did before -- does not crash a
// client (probed live: an initialize carrying 2025-11-25 got a 200 back), but a
// strict client SDK is entitled to treat the mismatch as a failed negotiation
// and disconnect.
//
// Lives here rather than in route.ts because Next.js rejects any export from a
// route file that is not an HTTP handler, and this needs to be testable.

/** The version this server speaks when the client asks for nothing usable. */
export const PROTOCOL_VERSION = "2025-06-18";

/** Every version this server can speak. */
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

/**
 * Echo the client's requested protocol version when we support it, otherwise
 * answer with our own. Anything that is not a supported string -- absent,
 * numeric, an object, a version from the future -- falls back.
 */
export const negotiateProtocol = (requested: unknown): string =>
  typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : PROTOCOL_VERSION;
