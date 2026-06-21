// Security posture for the auth gates.
//
// Both gates default to "empty secret = open": APP_PASSWORD (the human login)
// and MCP_TOKEN (the agent-facing MCP write endpoint). That zero-config default
// is fine on a loopback address, but it's a real exposure the moment the server
// is reachable by anyone (Vercel / self-host). So in production we require the
// secrets to be set — unless the operator explicitly opts into an open
// deployment with OPENVAULT_PUBLIC=1.
//
// This module is the single source of truth for that policy. It only reads
// process.env, so it is safe to import from the boot hook, route handlers, and
// the human auth helpers alike.

// Values that mean "AUTH_SECRET was never really set": the in-code dev fallback
// and the placeholder we ship in .env.example. A set APP_PASSWORD with one of
// these is still bypassable — session cookies are HMAC-signed with a key any
// reader of the repo already knows, so they can be forged.
const PLACEHOLDER_AUTH_SECRETS = new Set([
  "",
  "dev-only-change-me",
  "change-me-to-a-long-random-string",
]);

// Did the operator explicitly opt into running with open gates?
export function isPublicOptIn(): boolean {
  return process.env.OPENVAULT_PUBLIC === "1";
}

// True when empty/weak auth secrets are a hard error rather than a local-dev
// convenience: a production build that didn't opt into being public.
export function secretsRequired(): boolean {
  return process.env.NODE_ENV === "production" && !isPublicOptIn();
}

export type SecretProblem = { name: string; reason: string };

// Auth gate secrets that are unset or left at a known-insecure placeholder.
// Empty in plain dev is expected and harmless — callers decide whether the
// problems matter by also consulting secretsRequired().
export function auditSecrets(): SecretProblem[] {
  const problems: SecretProblem[] = [];

  // Human login gate: APP_PASSWORD + a real AUTH_SECRET work together.
  if (!process.env.APP_PASSWORD) {
    problems.push({ name: "APP_PASSWORD", reason: "human login gate is open to anyone" });
  } else if (PLACEHOLDER_AUTH_SECRETS.has(process.env.AUTH_SECRET ?? "")) {
    problems.push({
      name: "AUTH_SECRET",
      reason: "session cookies are signed with a publicly-known key and can be forged",
    });
  }

  // Agent gate: the MCP write endpoint (set_status, append_update).
  if (!process.env.MCP_TOKEN) {
    problems.push({ name: "MCP_TOKEN", reason: "agent MCP write endpoint is open to anyone" });
  }

  return problems;
}

function loud(color: "red" | "yellow", text: string): string {
  const code = color === "red" ? "31" : "33";
  return `\x1b[1;${code}m${text}\x1b[0m`;
}

// Called once at server boot (see src/instrumentation.ts). Refuses to start a
// production server whose gates would be open; otherwise stays out of the way,
// except to shout when the operator deliberately runs open via OPENVAULT_PUBLIC.
export function assertSecureBoot(): void {
  const problems = auditSecrets();
  if (problems.length === 0) return;

  const list = problems.map((p) => `${p.name} (${p.reason})`).join("; ");

  if (secretsRequired()) {
    const msg =
      `OpenVault refusing to start — ${list}. ` +
      `Set these before exposing the server, or set OPENVAULT_PUBLIC=1 to run ` +
      `with open gates on purpose (not recommended).`;
    console.error(loud("red", `[openvault] ${msg}`));
    throw new Error(msg);
  }

  // Running open is permitted here (local dev, or an explicit opt-in). Stay
  // quiet for ordinary localhost dev, but make an opted-in open deployment loud.
  if (isPublicOptIn()) {
    console.warn(
      loud(
        "yellow",
        `[openvault] OPENVAULT_PUBLIC=1: running with OPEN gates — ${list}. ` +
          `Anyone who can reach this server has full read/write access.`,
      ),
    );
  }
}
