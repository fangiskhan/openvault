// Prints this project's OpenVault briefing at the start of a Claude Code
// session. The hook's stdout becomes session context, so the agent begins
// already knowing the project's state — no tool calls, no tokens spent asking.
//
// This is a script rather than the `curl -s` one-liner it replaces, for two
// reasons that cost six weeks between them:
//
//   1. AUTH. A deployed vault requires a bearer token. A hook COMMAND string is
//      not a guaranteed place to expand $OPENVAULT_TOKEN (it is not expanded the
//      same way on every shell and platform), so the token is read here in Node,
//      where it always works.
//   2. VISIBILITY. `curl -s` prints nothing when it fails. A session that got no
//      briefing looked exactly like a session for which none existed, so a
//      matcher bug that skipped every resumed session went unnoticed for six
//      weeks. This says one short line on stderr instead of failing invisibly.
//
// The project is addressed by SLUG, not by id, so this file works unchanged in
// anyone's clone. Override either value if your vault is elsewhere:
//   OPENVAULT_URL     default http://localhost:6900
//   OPENVAULT_PROJECT default openvault
//   OPENVAULT_TOKEN   an ovk_ account token; only needed when the vault has
//                     secrets configured (any real deployment)

const VAULT = (process.env.OPENVAULT_URL ?? "http://localhost:6900").replace(/\/+$/, "");
const PROJECT = process.env.OPENVAULT_PROJECT ?? "openvault";
// Strip a BOM: a token piped into an env var on Windows PowerShell carries one,
// and it lands in the Authorization header as an unencodable character.
const TOKEN = (process.env.OPENVAULT_TOKEN ?? "").replace(/^﻿/, "").trim();

// 10s, not the 2s the activity hook uses: this runs against a Next dev server
// that compiles the route on first hit. Measured cold: >3s. Warm: ~20ms. A hook
// that gives up during the first compile of the day reports a live vault as
// unreachable — which is the exact class of lie this script exists to stop.
const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), 10_000);

try {
  const res = await fetch(`${VAULT}/api/brief/${encodeURIComponent(PROJECT)}`, {
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    signal: ctl.signal,
  });
  if (res.ok) {
    process.stdout.write(await res.text());
  } else if (res.status === 401) {
    // The one failure with an action attached, so it names the action.
    console.error(`openvault brief: 401 from ${VAULT} — set OPENVAULT_TOKEN to an ovk_ token for this vault.`);
  } else if (res.status === 404) {
    console.error(`openvault brief: no project '${PROJECT}' in ${VAULT} — set OPENVAULT_PROJECT to its slug.`);
  } else {
    console.error(`openvault brief: ${VAULT} answered HTTP ${res.status}.`);
  }
} catch (err) {
  // A vault that is off is the NORMAL case for someone who cloned this repo and
  // has not started one, so this stays a single quiet line rather than a stack.
  const offline = err?.name === "AbortError" || Boolean(err?.cause?.code ?? err?.code);
  console.error(
    offline
      ? `openvault brief: no vault reachable at ${VAULT} (skipping). Run 'npm run dev' here, or unset this hook.`
      : `openvault brief: ${err?.message ?? err}`,
  );
} finally {
  clearTimeout(timer);
}

// ALWAYS exit 0. A briefing is a convenience; it must never block a session.
process.exit(0);
