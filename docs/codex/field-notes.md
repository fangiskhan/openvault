# Codex CLI field notes: connecting to OpenVault over MCP

Every entry: date, `codex --version` verbatim, what the docs say, what happened.
Nothing here is inferred from docs alone. Where a number's only record is the
launching session's shell transcript rather than a file in this directory or
a Codex rollout, the entry says so. A second pass of seven independent
reviewers checked every claim against the artifacts on 2026-09-10; their
corrections are folded in.

Artifacts in this directory. No bearer token appears in any of them (checked
by grep after every run, scope `~/.codex` and `docs/codex`; the launching
transcript holds the shell command that read the token from disk, not the
value):

| File | What it is |
| --- | --- |
| `first-call.jsonl` / `.stderr` | The successful end-to-end call (`--approve-for-me`). Byte-identical copies of `attempt-approve-for-me.*`, made at 21:56; the run itself was 21:47:08 |
| `first-call-auth-failure.jsonl` / `.stderr` | First attempt: dead ChatGPT refresh token |
| `first-call-approval-never.jsonl` / `.stderr` | Plain `codex exec`: MCP call refused by approval policy |
| `attempt-approval-writes.jsonl` / `.stderr` | `default_tools_approval_mode="writes"` override: no effect |
| `attempt-approve-for-me.jsonl` / `.stderr` | Same content as `first-call.jsonl` |
| `attempt-allowlist-10.jsonl` / `.stderr` | 10-tool `enabled_tools` allowlist, `--strict-config` |
| `attempt-allowlist-blocked-tool.jsonl` / `.stderr` | Asks for a tool outside the allowlist |
| `attempt-no-mcp-baseline.jsonl` / `.stderr` | Both servers `enabled=false` (see contamination note) |
| `attempt-wire-regen.jsonl` / `.stderr` | A plain `--approve-for-me` run made to regenerate the wire log |
| `wire-handshake.log` | Proxy capture of the `openvault-local` handshake from the `attempt-wire-regen` run only |

Codex's own records: `~/.codex/sessions/2026/09/10/rollout-*.jsonl`, eight
with `source: "exec"` (21:41:18, 21:45:48, 21:46:53, 21:47:08, 21:48:36,
21:50:58, 21:52:40, 21:57:00 local) and four guardian subagent threads.
Timings quoted below are `task_complete.duration_ms` from those files.

## 2026-09-10 · codex-cli 0.153.4

### Install and version

- `npm view @openai/codex versions --json` on 2026-09-10: `0.153.4` exists.
  `dist-tags`: `latest` = `0.154.0`, `alpha` = `0.155.0-alpha.1`. Not
  archived; re-run to reproduce.
- `npm install -g @openai/codex@0.153.4` printed `added 2 packages` (the
  package plus `@openai/codex-win32-x64`; the other platform optional
  dependencies were skipped). Recorded only in the launching transcript.
- `codex --version` prints `codex-cli 0.153.4`. The GitHub release for the
  same build is tagged `rust-v0.153.4` (published 2026-09-04). The two strings
  are not interchangeable in a pin.
- `codex doctor` at the end of the evening: `0.154.0 available (current
  0.153.4)`, `configured servers 2 / disabled servers 0 / streamable_http
  servers 2`, `feature flags 48 enabled · 0 overridden`.

### (a) `codex mcp add`: the flags that worked, against the docs

Ran verbatim from `D:\openvault` with `OPENVAULT_TOKEN` exported (loaded from
the Claude Code MCP config by a shell command; the value was never typed or
printed):

```
codex mcp add openvault --url https://openvault-hub.vercel.app/api/mcp --bearer-token-env-var OPENVAULT_TOKEN
```

Output: `Added global MCP server 'openvault'.` (transcript; the command
writes `~/.codex` so the reviewers could not re-run it).

- `--url` and `--bearer-token-env-var` are the documented names and the
  parser accepted them as documented. No divergence.
- `codex mcp add --help` also lists `--env <KEY=VALUE>` (stdio only),
  `--oauth-client-id`, `--oauth-client-registration <AUTO|CIMD|DCR>` (possible
  values `auto, cimd, dcr`), `--oauth-resource`, and the global `-c`,
  `--enable`, `--disable`.
- `codex mcp --help` lists six server subcommands, `list`, `get`, `add`,
  `remove`, `login`, `logout`, plus the auto-generated `help`. The vault's
  2026-09-08 docs read named only `add` and `list`. `get` is the one that
  shows the stored record.
- `codex mcp list` prints `Name · Url · Bearer Token Env Var · Status · Auth`.
  The row read `openvault · https://openvault-hub.vercel.app/api/mcp ·
  OPENVAULT_TOKEN · enabled · Bearer token`. The `Auth` column names the
  method; it is not a verified state.
- `codex mcp get openvault` reports `transport: streamable_http`, yet the block
  it wrote to `~/.codex/config.toml` has **no `transport` key**:

  ```toml
  [mcp_servers.openvault]
  url = "https://openvault-hub.vercel.app/api/mcp"
  bearer_token_env_var = "OPENVAULT_TOKEN"
  ```

  Transport is inferred from `url`. Do not copy `transport = "streamable_http"`
  into config.toml from `get`'s output; the CLI itself does not write it.
- **Tool names are `mcp__<server>__<tool>`, with hyphens in the server name
  replaced by underscores.** The rollouts declare the second server's tools as
  `mcp__openvault_local__<tool>` while the JSONL `mcp_tool_call` events still
  say `"server":"openvault-local"`, and the model listed both namespaces as
  `openvault` and `openvault_local`. Pick names without hyphens.
- `codex doctor` checks that the env var is **set**, not that it works. With
  `OPENVAULT_TOKEN` unset it prints `⚠ mcp MCP configuration has optional
  issues - Set the missing MCP env vars or disable the affected server.`,
  does not name the variable, and exits 0. With any value at all, including
  a placeholder, it prints `✓ mcp`. `codex mcp list` shows `enabled · Bearer
  token` either way, so `list` is not the check and `doctor` is only half of
  one.
- Token hygiene: config.toml stores the env var **name** only. After `add`,
  `list`, `get`, `doctor` and eight `exec` runs, a grep for the token value
  across `~/.codex` and `docs/codex` returned 0 files (author's grep, not
  archived).

### (b) `--full-auto`, and the approval and sandbox vocabulary that exists

`--full-auto` is not accepted on 0.153.4. It appears in neither `codex --help`
nor `codex exec --help`, and `codex exec --full-auto --help` answers `error:
unexpected argument '--full-auto' found`, exit 2. What exists, verbatim from
the help text:

- `--approve-for-me` (both `codex` and `codex exec`) — "Route approval
  requests through automatic review using the workspace-write sandbox"
- `-a, --ask-for-approval <APPROVAL_POLICY>` — **on the interactive `codex`
  command only**; `codex exec -a never --help` answers `error: unexpected
  argument '-a' found`, exit 2. Two values: `on-request` ("The model decides
  when to ask the user for approval") and `never` ("Never ask for user
  approval Execution failures are immediately returned to the model", with
  no punctuation between the sentences in the help text)
- `-s, --sandbox <SANDBOX_MODE>` (both) — `read-only`, `workspace-write`,
  `danger-full-access`
- `--dangerously-bypass-approvals-and-sandbox` (both) — "EXTREMELY DANGEROUS".
  Not tried.
- `--dangerously-bypass-hook-trust` (both)

What the defaults turned out to be, from `turn_context` in the rollouts:

- Plain `codex exec` runs with `approval_policy: "never"`,
  `approvals_reviewer: "user"`, `sandbox_policy: {"type":"read-only"}`.
  `codex doctor` reports the interactive default as `approval OnRequest`.
  The two surfaces have different defaults and neither says so.
- `codex exec --approve-for-me` runs the main thread at `approval_policy:
  "on-request"`, `approvals_reviewer: "auto_review"`, and spawns a second
  thread with `source: {"subagent":{"other":"guardian"}}`, model
  `codex-auto-review`, `approval_policy: "never"`, that rules on each
  approval request. The feature flag is `guardian_approval · stable · true`.
- The `--approve-for-me` help text says "using the workspace-write sandbox".
  Every `--approve-for-me` main thread recorded `sandbox_policy:
  {"type":"read-only"}`. The help text and the recorded policy disagree.

### `codex exec` blocks on stdin in a non-TTY shell

`codex exec --json "<prompt>"` from a tool-driven shell (stdin open, not a
terminal) waited. The launching transcript records the wrapper killing it at
240 s with zero JSONL lines written and no rollout created; Codex never
reached session creation, so no artifact of that run exists in this directory
or in `~/.codex/sessions`. The help text says stdin is appended as a
`<stdin>` block "if stdin is piped and a prompt is also provided"; it does not
say the turn will not start until EOF.

Fix: `codex exec --json "<prompt>" < /dev/null`. With stdin closed, the gap
from `session_meta` to the first `turn_context` in the rollouts was 1.2–3.0 s
across the seven completed runs.

Do not use the stderr line as the diagnostic: `Reading additional input from
stdin...` is printed on **every** non-TTY run, including all eight with
`< /dev/null` (each `.stderr` here is exactly that one line). `codex doctor`
records the environment as `stdin is terminal false`. Any hook, CI job or the
planned `scripts/demo.sh` that calls `codex exec` has to close stdin.

### `codex login status` does not check that the login works

- `codex login status` → `Logged in using ChatGPT`.
- The next `codex exec` failed in about 4 s. `first-call-auth-failure.stderr`
  lines 2–9 print, pretty-printed:
  `codex_login::auth::manager: Failed to refresh token: 401 Unauthorized:
  {"error":{"message":"Your refresh token has already been used to generate a
  new access token. Please try signing in again.","type":"invalid_request_error","param":null,"code":"refresh_token_reused"}}`,
  repeated; then `codex_models_manager::manager: failed to refresh available
  models: unexpected status 401 Unauthorized: Could not parse your
  authentication token`; then lines 25–26,
  `rmcp::transport::worker: worker quit with fatal: Transport channel closed,
  when UnexpectedServerResponse("HTTP 401: {"error":{"message":"Could not
  parse your authentication token. Please try signing in
  again.","type":null,"code":"unauthorized_unknown","param":null},"status":401}")`.
- So `login status` reports that `~/.codex/auth.json` exists with
  `auth_mode = chatgpt`. It does not validate the refresh token. The server
  said the token had been reused; what consumed it is not recorded.
- `auth.json` fields (values not recorded): `auth_mode`, `OPENAI_API_KEY`
  (null), `tokens.id_token`, `tokens.access_token`, `tokens.refresh_token`,
  `tokens.account_id`, `last_refresh`.
- The MCP client library is `rmcp` (Rust MCP SDK); it logs under
  `rmcp::transport::worker`.
- The 401 bodies rmcp quoted are in ChatGPT-backend shape
  (`"code":"unauthorized_unknown"`). OpenVault's 401 bodies are JSON-RPC
  shaped: `{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"unauthorized"}}`
  with no bearer, `"unknown token"` with a bearer that does not resolve
  (`src/app/api/mcp/route.ts:63`, `:52`). Those two 401s therefore came from
  the ChatGPT backend. Whether Codex also attempted the vault's `initialize`
  in that run is not recorded; the rollout has no MCP events.
- That rollout recorded model `gpt-6-astra`, because the model-list refresh
  had 401'd; every later run recorded `gpt-5.6-terra`.
- JSONL emitted: `thread.started`, `turn.started`, `error`, `turn.failed`.
  Four lines.

Resolved by the owner running `codex logout` then `codex login` in a
terminal. No key was pasted anywhere.

### The approval wall, and what actually opened it

With login fixed, the same 18-word prompt ran three ways: *"Use the openvault
MCP server: call get_briefing for the project named OpenVault and print its
headline text verbatim."*

1. **Plain `codex exec --json`** (`first-call-approval-never.jsonl`, rollout
   21:45:48, 15,320 ms). Codex picked the `openvault` server, called
   `get_briefing` with `{"projectId":"OpenVault"}`, and its own harness
   returned `MCP tool call requires approval, but approval policy is never`.
   Final message: *"I couldn’t retrieve it: the OpenVault MCP call requires
   approval, but approvals are disabled in this session."* Whether an HTTP
   request went out before the refusal is not recorded. A non-interactive
   run cannot call any MCP tool by default.
2. **`-c 'mcp_servers.openvault.default_tools_approval_mode="writes"'`**
   (`attempt-approval-writes.jsonl`, rollout 21:46:53, 13,792 ms). The
   vault's docs read lists this key as the way to auto-approve read tools.
   Identical failure, same error string; final message *"Unable to retrieve
   it: the OpenVault MCP call requires approval, but this environment’s
   approval policy disallows it."* The override string appears in no rollout
   and no config; only the launching transcript shows it was passed. On
   0.153.4 under `exec` it changed nothing observable. Not tested in the TUI.
3. **`--approve-for-me`** (`first-call.jsonl`, rollout 21:47:08, 22,359 ms).
   Worked. Codex called `list_projects`, then `get_briefing` with
   `{"projectId":"cms5bs1zy0000l7047mxueapq"}`, both `status: completed`.
   The result carried `"headline": {"rag": "green", "text": "On track — no
   blocking signals in the window."}` with `coverage.itemsConsidered: 38`,
   and the final agent message was that text verbatim. JSONL events:
   `thread.started`, `turn.started`, 2 × `item.started / mcp_tool_call`,
   2 × `item.completed / mcp_tool_call`, 2 × `item.completed /
   agent_message`, `turn.completed`.

Cost of the approval route: four guardian threads ran this evening
(`codex-auto-review`). First-call `input_tokens` 9,242 / 7,466 / 8,772 /
8,400; two of the four made a second call (9,937 / 8,152). About 4,864 of
each first call was cache reads, so the fresh cost per approval decision is
nearer 2.6–4.4k tokens than the headline figures. Guardian decisions took
2.1–3.8 s each.

### (c) The MCP protocol version Codex sends

Captured on the wire with a logging proxy at `http://localhost:6901/api/mcp`
that forwarded to the live vault (registered in Codex as `openvault-local`).
`wire-handshake.log` is the capture from the `attempt-wire-regen` run
(21:57:00); the proxy log was cleared before every earlier run, so those
handshakes survive only as one-line summaries in the launching transcript.
Every one of them showed the same three requests, each starting with a fresh
`initialize`, so no session was reused between runs.

| # | Request | Codex sent | Server answered | Logged at (UTC) |
| --- | --- | --- | --- | --- |
| 1 | `initialize` | `protocolVersion: "2025-06-18"`, `clientInfo: {"name":"codex-mcp-client","title":"Codex","version":"0.153.4"}`, `capabilities: {"elicitation":{"form":{},"url":{}}}` | 200, 3,615 bytes, echoed `2025-06-18` | 12:57:00.596 |
| 2 | `notifications/initialized` | header `MCP-Protocol-Version: 2025-06-18` | 202, 0 bytes | 12:57:00.826 |
| 3 | `tools/list` | same header | 200, 30,586 bytes, 48 tools | 12:57:01.221 |

Request headers throughout: `user-agent: codex-mcp-client/0.153.4`,
`accept: text/event-stream, application/json`, `content-type:
application/json`. The `MCP-Protocol-Version` header appears on requests 2
and 3, not on `initialize`. The three requests span 625 ms; the `initialize`
response was logged 293 ms after the Codex session's `session_meta`
timestamp. OpenVault's `negotiateProtocol` echoed the requested version;
nothing fell back.

Codex also hits the URL outside the MCP client, with `user-agent:
codex_cli_rs/0.153.4 (Windows 10.0.26100; x86_64)`, non-JSON-RPC requests
that the vault answered 405. Seven of those followed `codex doctor` and
`codex mcp` invocations; a server that logs by user agent will see both.

### (d) Connect cost: what 48 schemas cost Codex

**On the wire.** The `tools/list` response for 48 tools is **30,586 bytes**:
7,647 tokens at bytes ÷ 4, or 7,626 at characters ÷ 4 (30,502 characters;
42 of them are 3-byte UTF-8). `scripts/measure-context.mjs` computes 7,615
for the same tools; the difference is a 44-byte JSON-RPC envelope plus the
84 bytes of multibyte overhead the script does not count. Every `exec` pays
this transfer once per configured server. It is a bandwidth and latency
number.

**In Codex's own accounting.** `token_usage_record.usage.input_tokens` for the
first and second model calls of every completed run. Rows 1–4 and 6–7 used
the identical 18-word prompt; row 5 used a 42-word prompt asking for
`get_graph`. "Schemas visible" is observed where the model listed them and
inferred (2 × 48) where its listing was truncated.

| Run (local) | Flags | User MCP schemas visible | 1st call | 2nd call | Δ | Untruncated tool listing |
| --- | --- | --- | --- | --- | --- | --- |
| 21:45:48 | plain `exec` | 96, inferred | 14,550 | 23,276 | +8,726 | 99,039 tokens |
| 21:46:53 | `default_tools_approval_mode` override | 96, inferred | 14,550 | 23,279 | +8,729 | 99,039 |
| 21:47:08 | `--approve-for-me` | 96, inferred | 15,353 | 24,078 | +8,725 | 99,039 |
| 21:48:36 | + 10-tool allowlist, both servers | 20, inferred | 15,353 | 24,055 | +8,702 | 19,967 |
| 21:50:58 | same flags, `get_graph` prompt | 20, observed | 15,382 | 24,096 | +8,714 | 19,967 |
| 21:52:40 | `--approve-for-me`, both servers `enabled=false` | 0, observed | 15,353 | 15,460 | +107 | — |
| 21:57:00 | `--approve-for-me` (regen) | 96, inferred | 15,353 | 24,094 | +8,741 | 99,039 |

Reading the table: the first call does not move with the schema count at
all (14,550 or 15,353 regardless; `--approve-for-me` adds 803; the longer
prompt adds 29). The second call moves by about **+8,700 tokens whenever any
MCP tools are configured, and by +107 when none are**, and it moves by the
same amount for 96 schemas as for 20.

**Why.** The rollouts show the mechanism. Codex does not inline MCP schemas
into the prompt. It exposes every tool to the model as an entry of an
`ALL_TOOLS` array inside its `exec` script tool (`code_mode_host · stable ·
true`). In every run the model's first action is a script such as
`ALL_TOOLS.filter(x => /openvault|get_briefing/i.test(x.name+" "+x.description))`,
and it calls tools from inside a script as
`tools.mcp__openvault__get_briefing({...})`. The filtered listing comes back
as tool output on the next call, truncated at about 40 KB with a header
that states the untruncated size: `original token count: 99039` for 96
schemas, `19967` for 20. That truncation cap is why 96 and 20 cost the same.
Untruncated, Codex's representation of a schema is roughly 1,030 tokens
against about 160 for the raw JSON the vault serves.

So the vault's 7,615-token "connect cost" figure assumes a client that
inlines schemas into the prompt. Codex does not, and still pays about 8,700
input tokens of schema text on the second call of every run in which the
model searches its tool list, regardless of how many tools are configured.
(Whether Claude Code inlines them is not covered by these artifacts.)

**`enabled_tools` is enforced, and costs nothing either way.** With
`-c 'mcp_servers.openvault.enabled_tools=[...10 names...]'` on both servers
and `--strict-config` (whose help text promises an error for unrecognised
config.toml fields; whether it validates `-c` overrides is not stated, and
nothing errored), a prompt asking for `get_graph` got: *"`get_graph` is not
available. I can see these OpenVault tools: `get_attention`, `get_briefing`,
`get_code_map`, `get_recent_activity`, `get_status`, `list_projects`,
`read_code`, `read_item`, `search`, `search_code` — each under both
`openvault` and `openvault_local` namespaces."* Exactly the ten. The proxy
still received the full 48-tool `tools/list` on the allowlist run (recorded
only in the launching transcript's proxy summary; the saved log is from the
later regen run), so the filter is client-side, after the transfer. Use the
allowlist to narrow what the model can *do*; do not expect it to change what
a turn costs.

### (e) Timeouts

- No MCP timeout value is surfaced by `codex mcp get`, `codex mcp add --help`,
  `codex exec --help` or `codex doctor`. The vault's docs read names
  `startup_timeout_sec` and `tool_timeout_sec` as config keys; their defaults
  could not be observed and were not needed. (`logs_2.sqlite` was also
  searched; its `logs` table has 0 rows, so that search proves nothing.)
- The timeouts `doctor` does print are both the model-provider websocket:
  `15s timeout` in the summary, `connect timeout 15000 ms` in detail.
- No MCP timeout was hit. `task_complete.duration_ms` for the seven completed
  runs, in order: 15,320 / 13,792 / 22,359 / 19,406 / 13,500 / 24,869 /
  21,703. Shell-measured wall times, transcript only, were 18 / 15 / 23 / 20 /
  15 / 26 / 23 s.
- The only timeout of the evening was the external 240 s wrapper around the
  stdin-blocked run, which is not a Codex timeout.

### A server the JSONL names `codex`

In the run with both user servers disabled, the model still made an
`mcp_tool_call` that the JSONL labels `server: "codex"`, tool
`list_mcp_resources`, which returned plugin resources (`server:
"codex_apps"`, e.g. a "Deep Research" plugin at a `plugin://` URI). The
rollout shows it was issued from the same `exec` script tool
(`tools.list_mcp_resources`). One run, one observation; a session with no
`mcp_servers` block at all was not tested. Treat the name `codex` as taken.

### The no-MCP baseline answered correctly, and that was contamination

`attempt-no-mcp-baseline.jsonl`, run with `-c mcp_servers.openvault.enabled=false
-c mcp_servers.openvault-local.enabled=false`, returned *"On track — no
blocking signals in the window."* with no vault server available. It ran
`rg -n --hidden --glob '!node_modules' "get_briefing|openvault" .` and the
headline appeared in the output at line 7 of both
`docs/codex/attempt-allowlist-10.jsonl` and
`docs/codex/attempt-approve-for-me.jsonl`, saved output of runs earlier that
evening. Which of the two it read is not recorded; it issued no further read.
The proxy saw nothing (servers disabled; transcript summary).

The token numbers from that run are valid (the table above uses them). The
"still answered" is not evidence of anything except that the working
directory contained the answer. A control run meant to show what Codex can
do *without* the vault must start in a directory that holds no prior
transcripts, and the planned `scripts/demo.sh` should run its second agent
from a clean checkout for the same reason.

### Model behaviour worth knowing before a demo

- **`get_briefing` accepts the project name, and that is a hazard.** In the
  refused run the model passed `{"projectId":"OpenVault"}`. In
  `attempt-wire-regen.jsonl` it did the same with approvals on, the call
  **completed**, and the result read `coverage.itemsConsidered: 0` with the
  same headline text as the real briefing (`itemsConsidered: 38` when called
  with the cuid). `src/lib/projects.ts` does no name lookup, so a name-keyed
  call returns an empty-scope briefing that looks right. In the run that
  used the id, the model had called `list_projects` first; which path it
  takes is not stable across runs with the same prompt.
- Model for runs where the model-list refresh succeeded: `gpt-5.6-terra`.
  The successful run took 6 model responses; cumulative input for the turn
  was 153,647 tokens, 130,560 of them cached.
- Every `exec` performs the full MCP handshake for every configured server,
  including servers the model never calls.

### Interactive `codex`: first launch, and what `/mcp` lists

**First launch, `OPENVAULT_TOKEN` not exported in that shell** (owner's
terminal, directory `~`, pasted verbatim):

```
⚠ MCP client for `openvault` failed to start: MCP startup failed: Environment variable OPENVAULT_TOKEN for MCP server
  'openvault' is not set

⚠ MCP startup incomplete (failed: openvault)
```

So the unset-variable case is now observed on every surface. `codex mcp
list`: no indication. `codex doctor`: a warning that does not name the
variable, exit 0. Interactive `codex`: the MCP client does not start, and
the error names the variable and the server. Whether a header would have
been sent is moot; the client never initialises. The earlier Connect-panel
wording "sends no header and every call fails" described a state that does
not occur.

Two other things the interactive first launch showed that `exec` never did:
an update banner (`0.153.4 -> 0.154.0`, matching `doctor`), and a Windows
sandbox setup prompt (`Set up default sandbox (requires Administrator
permissions)` / `Use non-admin sandbox (higher risk if prompt injected)` /
`Quit`) that must be answered before any prompt. The eight `exec` runs
recorded `sandbox_policy: {"type":"read-only"}` without ever asking.

**Second launch, `OPENVAULT_TOKEN` exported, then `/mcp`** (owner's
PowerShell, directory `~`, pasted verbatim). Note the version: between the
two launches the owner ran the update the banner suggested, so this
observation is on **codex-cli 0.154.0** (published 2026-09-09), not the
0.153.4 pin every other number in these notes comes from. The global install
was re-pinned to 0.153.4 afterwards.

```
$env:OPENVAULT_TOKEN = ((Get-Content "$HOME\.claude.json" -Raw | ConvertFrom-Json).mcpServers.'openvault-live'.headers.Authorization -replace '^Bearer\s+','')
$env:OPENVAULT_TOKEN.Length
52
codex
╭─────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.154.0)                  │
│ model:     gpt-5.6-terra   /model to change │
│ directory: ~                                │
╰─────────────────────────────────────────────╯

/mcp

🔌  MCP Tools

  • codex_apps: connected (12 tools)
  • openvault: connected (48 tools)

  Use /mcp verbose for tools and resources.
```

- No `MCP startup failed` warning this time, and no sandbox prompt (either
  the first launch's answer persisted or 0.154.0's Windows sandbox
  provisioning changes suppressed it; not determined).
- `openvault: connected (48 tools)`: the full surface, no allowlist, matching
  the 48 the proxy counted in `tools/list`.
- The built-in server shows as **`codex_apps` with 12 tools**. In the `exec`
  JSONL the same run-time facility appeared as `server: "codex"` (tool
  `list_mcp_resources`) whose result listed resources under
  `server: "codex_apps"`. Treat both names as taken.
- `/mcp verbose` exists for per-tool and resource listings; not run.

## Commands that make up the tested README block

```
export OPENVAULT_TOKEN=ovk_...        # placeholder; the runs loaded it from the shell environment
codex mcp add openvault --url https://openvault-hub.vercel.app/api/mcp --bearer-token-env-var OPENVAULT_TOKEN
codex mcp list
codex exec --json --approve-for-me "Use the openvault MCP server: call get_briefing for the project named OpenVault and print its headline text verbatim." < /dev/null
```

The Codex form in the Connect panel (`src/components/AppShell.tsx`; the
connect-kit route has no Codex content) emits the same export and `codex
mcp add` pair with the URL taken from the page origin. Its "unverified"
notice was replaced by a line stating what was tested and on which URL.

## 2026-09-11 · codex-cli 0.153.4 · evening 2

Pin verified at the start (`codex --version` → `codex-cli 0.153.4`).
Artifacts: `docs/codex/evening2-*.jsonl` and `.stderr`; Codex rollouts under
`~/.codex/sessions/2026/09/11/`, cited below by their `T18-mm-ss` timestamp.
The pre-evening `~/.codex/config.toml` was copied to the session scratchpad
before any edit. Token loaded from `~/.claude.json` by the same one-liner as
evening 1. A grep of `AGENTS.md`, this file and every `evening2-*` artifact
for the token value returned 0 files (author's grep; scope did not include
the rollouts or the config backup). Exit codes and command-line flags are
recorded only in the launching session's transcript; the rollouts record
`approval_policy` (`never` = plain `exec`, `on-request` = `--approve-for-me`),
which is how each run's flag is confirmed below. A second pass of six
independent reviewers checked every claim on 2026-09-11; their corrections
are folded in.

### The kit block, and which keys 0.153.4 accepts

Written into `~/.codex/config.toml` itself rather than passed with `-c`, so
that `--strict-config`, whose help text scopes it to config.toml fields
("Error out when config.toml contains fields that are not recognized by this
version of Codex"), actually validates it:

```toml
[mcp_servers.openvault]
url = "https://openvault-hub.vercel.app/api/mcp"
bearer_token_env_var = "OPENVAULT_TOKEN"
required = true
default_tools_approval_mode = "writes"
enabled_tools = ["list_projects", "get_briefing", "get_status", "get_attention", "search", "read_item", "get_recent_activity", "get_code_map", "read_code", "search_code"]
disabled_tools = ["delete_item"]
```

- `codex exec --json --strict-config "Reply with the single word OK." < /dev/null`
  (`evening2-strict-config.*`, rollout T18-35-37): final message `OK`; stderr
  held exactly one line, the stdin banner; the shell reported exit 0. All four
  new keys accepted.
- `codex mcp get openvault` displays `enabled_tools`, `disabled_tools` and
  `default_tools_approval_mode: writes`. It does **not** display `required`.
  Accepted by the parser, invisible in `get`.

### What each key does under `exec`

- **`required = true`** (`evening2-2c-required-unset-var.*`, no rollout: the
  session was never created). With `OPENVAULT_TOKEN` unset, stderr:
  `codex_core::session: Failed to create session: required MCP servers failed
  to initialize: openvault: Environment variable OPENVAULT_TOKEN for MCP
  server 'openvault' is not set`, then `Error: thread/start: thread/start
  failed: error creating thread: Fatal error: Failed to initialize session:
  required MCP servers failed to initialize: openvault: Environment variable
  OPENVAULT_TOKEN for MCP server 'openvault' is not set (code -32603)`. Zero
  JSONL events; the shell reported exit 1 in about a second. The only
  without-`required` observation is evening 1's interactive launch, which
  warned and continued; no plain-`exec` run without the key and with the
  variable unset was made, so the contrast is across surfaces.
- **`disabled_tools = ["delete_item"]`**. The first test
  (`evening2-2b-disabled-delete-item.*`, rollout T18-37-01, `--approve-for-me`)
  ran under the full block, where the ten-name allowlist already excludes
  `delete_item`, so it proved nothing about `disabled_tools` on its own. The
  isolating run (`evening2-2b-isolated-disabled-only.*`, rollout T19-05-10,
  `--approve-for-me`)
  removed `enabled_tools` and kept `disabled_tools`: the model listed its
  `mcp__openvault__` tools and reported *"47 tools found.
  `mcp__openvault__delete_item` is not among them."*, then the attempted call
  returned `TypeError: tools.mcp__openvault__delete_item is not a function`.
  48 → 47 with one key. The tool is absent from the harness namespace, not
  merely refused.
- **`enabled_tools`** (`evening2-2d-tool-listing-v2.*`, rollout T18-39-39,
  `--approve-for-me`). Asked to search its tool list for names starting
  `mcp__openvault__`, the model listed exactly the ten and said `10 tools.`
  An earlier attempt (`evening2-2d-tool-listing.*`, rollout T18-36-54, plain
  `exec`, prompt ending "Do not call any of them") answered *"No openvault MCP
  tools are currently visible."*; its rollout shows no tool search between the
  prompt and the reply, while run 2a in the same config ten seconds earlier
  had found `list_projects`. Kept as an artifact; not a finding about the
  allowlist.
- **`default_tools_approval_mode = "writes"`**
  (`evening2-2a-plain-exec-writes-mode.*`, rollout T18-36-44, plain `exec`).
  `list_projects` → `MCP tool call requires approval, but approval policy is
  never`. In the file, the same result as evening 1's `-c` override. Under
  `exec` the key changes nothing observable. Why is not shown by any
  artifact. Two candidates: `exec`'s `approval_policy: never` refuses before
  any per-tool mode is consulted; or the mode is consulted and decides
  read-versus-write from the MCP `readOnlyHint` annotation, which OpenVault
  does not send. `src/lib/mcp/tools.ts` contains no `annotations` at all and
  `tools/list` in `src/app/api/mcp/route.ts:117` ships only name, description
  and inputSchema. The owner's interactive run under this block (next
  subsection) ran both read tools with **no approval prompt**, which rules
  out the second candidate in the form that mattered: missing `readOnlyHint`
  does not force a prompt on reads. Whether the `"writes"` key did the work,
  or the TUI's `on-request` default simply did not ask, is not isolated;
  the next test is a write tool inside the allowlist under the same block.

### Interactive TUI run, 2026-09-12, under the full block

Owner's terminal, `OPENVAULT_TOKEN` exported, `codex` on 0.153.4 (the
update prompt offered 0.154.0 and was declined with "Skip until next
version"). Prompt: *"Use the openvault MCP server: call list_projects, then
get_briefing with the id of the project named OpenVault, and print the
headline verbatim."* Pasted verbatim, minus the tool-result JSON bodies:

```
• I'll retrieve the OpenVault project briefing and reproduce its headline exactly.

• Called openvault.list_projects({})
  └ [{"id": "cms5bs1zy0000l7047mxueapq", "name": "OpenVault", ...}, ...]

• Called openvault.get_briefing({"projectId":"cms5bs1zy0000l7047mxueapq"})
  └ {"scope": "project", ..., "headline": {"rag": "green", "text": "On track — no
        blocking signals in the window."}, ..., "coverage": {"itemsConsidered": 38, ...}}

• On track — no blocking signals in the window.
```

- No approval prompt appeared for either call. Rollout
  `~/.codex/sessions/2026/09/12/rollout-2026-09-12T13-53-34-*`: `cli_version`
  0.153.4, `source: "cli"`, `approval_policy: on-request`, `approvals_reviewer:
  user`. No guardian was involved; the TUI runs with the user as reviewer.
- The model resolved the id through `list_projects` first and the briefing
  came back with `itemsConsidered: 38`, the real one, not the empty-scope
  shape a name-keyed call returns.
- The TUI prints tool calls as `openvault.list_projects`, not the
  `mcp__openvault__` form the `exec` rollouts use.
- Not tested: a write tool under `"writes"` mode (none is in the allowlist),
  and the same reads with `default_tools_approval_mode` removed. Those two
  runs would say whether the key is doing anything in the TUI.

### Connect cost from config.toml, one server (the before/after)

Same 18-word prompt as evening 1, `--approve-for-me`, one configured server,
`AGENTS.md` at 4,600 bytes. `token_usage_record.usage.input_tokens`, first
and second model call, main thread. Config state per run is from the
launching transcript; the rollouts do not record it, and 3ii and 3iii are
indistinguishable in every artifact because `delete_item` is outside the
allowlist either way.

| Run | Config | Artifact / rollout | 1st call | 2nd call | Δ |
| --- | --- | --- | --- | --- | --- |
| 3i | `url` + `bearer_token_env_var` only | `evening2-3i-baseline.*` / T18-38-30 | 16,319 | 24,978 | +8,659 |
| 3ii | + `enabled_tools` (10) | `evening2-3ii-allowlist.*` / T18-38-55 | 16,319 | 24,971 | +8,652 |
| 3iii | + `disabled_tools` | `evening2-3iii-allowlist-disabled.*` / T18-39-17 | 16,319 | 24,974 | +8,655 |

- The first call is identical in all three. The second-call delta varies by
  7 tokens. **With this prompt, the allowlist does not change what a turn
  costs**, and the reason is a coincidence worth stating: in 3i the model's
  search (`x.name.includes("openvault")`, printing name and description)
  returned a listing the harness cut at 10,000 tokens (`original token
  count: 48975`, 11 names visible in the surviving head and tail); in 3ii and
  3iii the search (name or description) printed the ten allowlisted tool
  objects in full, 40,508 characters, uncut. Ten full schemas happen to be
  about the size of the cap. Three allowlisted tools would cost less; the
  allowlist is not cost-neutral in general.
- 48,975 untruncated tokens for the whole listing is about 1,020 per tool,
  matching evening 1's 99,039 for 96. That the listing held 48 tools is
  inferred from evening 1's proxy count; tonight's artifact shows only the
  11 names that survived truncation.
- What the model prints drives the delta. Listing ten names only (2d-v2,
  rollout T18-39-39) cost **+223** (16,521 → 16,744). The ~8.7k is echoed
  schema text, not a connect fee: evening 1 measured +107 with no MCP
  servers at all.
- Cross-check against evening 1: 16,319 − 15,353 = 966 tokens on the matched
  `--approve-for-me` pair (same prompt, same flag; evening 1 had two servers
  via `-c`, tonight one from config.toml, which evening 1's own table shows
  does not move the first call). The difference expected to move it is
  `AGENTS.md`, 678 → 4,600 bytes (`git show HEAD:AGENTS.md | wc -c` = 678);
  3,922 ÷ 4 = 980. The plain-`exec` pair, 4a's 15,678 against evening 1's
  14,550 with a different four-word prompt, gives +1,128. **`AGENTS.md` at
  this size costs roughly 970–1,130 tokens on every first call.**
- On the wire nothing was captured tonight. Evening 1's capture stands:
  `tools/list` carried all 48 regardless of the allowlist, which is applied
  client-side.

### `AGENTS.md`

- Written below the `<!-- END:nextjs-agent-rules -->` marker, since `next
  dev` rewrites that block on every boot; lines 1–9 are byte-identical to
  `HEAD:AGENTS.md`. 4,600 bytes. The 32 KiB `project_doc_max_bytes` cap is
  from the vault's 2026-09-08 docs read, not from any CLI output. The
  vault-first rules are lifted from the two templates the server generates in
  `src/app/api/connect-kit/route.ts` (the global `CLAUDE.md` at lines ~27–70
  and the per-project one at ~770–890) and from evening 1's findings (pass the
  project **id**; say so if an allowlisted tool is missing); the "Verifying
  this repository" section comes from this README and `package.json`.
  `CLAUDE.md` in this repo is `@AGENTS.md`, so Claude Code sessions here now
  receive the same loop.
- The plan's verification form, `codex --ask-for-approval never "Summarize
  the current instructions."`, opens the TUI: `-a` exists on interactive
  `codex` only (`codex exec --help` has no such flag). `codex exec --json
  "Summarize the current instructions." < /dev/null` was used instead.
- **Trust.** The pre-evening backup of `config.toml` holds one entry,
  `[projects.'c:\users\user'] trust_level = "trusted"`, and nothing for
  `D:\openvault`. The vault's 2026-09-08 docs read recorded that since 0.150
  untrusted projects load neither `AGENTS.md` nor project hooks; the docs
  sentence itself is not saved here.
- 4a (`evening2-4a-agents-summary-untrusted.*`, rollout T18-38-22, plain
  `exec`, run before any `[projects]` write tonight; the config at that
  instant is not snapshotted, only bounded by the backup before it and the
  writes after). The rollout's injected instructions begin `# AGENTS.md
  instructions for D:\openvault`, so the file was loaded. The summary quotes
  the loop: *"For project tasks, first consult OpenVault MCP: project
  briefing, activity, relevant team skills, and active work"*, *"Before
  editing, announce intended paths in OpenVault and check for
  overlaps/suggestions"*, *"Record useful decisions, findings, and handoffs
  back into OpenVault before finishing"*, *"Verify code changes with `npm run
  check`"*, and *"filesystem is read-only and approvals are unavailable"*,
  matching the rollout's `sandbox_policy: read-only`, `approval_policy:
  never`. First-call input 15,678.
- 4b (`evening2-4b-agents-summary-trusted.*`, rollout T18-39-52), after
  appending `[projects.'d:\openvault'] trust_level = "trusted"`: same
  substance in different wording (*"identify the project by ID, read its
  briefing/activity/skills/active work"*, *"announce intended work in the
  vault"*, *"record useful progress, decisions, and discoveries back to the
  vault before finishing"*), first-call input **15,678**, identical. **Under
  `exec` on 0.153.4, `AGENTS.md` was injected into a session whose cwd had
  no trust entry.** Whether the TUI's trust prompt gates it, and whether
  project hooks load, were not tested. The guardian subagent rollouts for
  3i–3iii begin with the same injected `AGENTS.md` block: the approval
  reviewer reads it too.

### Kit design note the numbers force

`AGENTS.md` names nineteen tools. Eleven are outside the ten-name allowlist:
six on the read side (`list_skills`, `get_skill`, `get_active_work`,
`list_suggestions`, `list_files`, `read_file`) and five writes
(`announce_work`, `append_update`, `import_notes`, `sync_code`,
`suggest_change`). An agent following the file under this block cannot
complete the start-of-task steps, let alone write back; evening 1's
blocked-tool run shows what it sees instead (*"`get_graph` is not
available"*). The intended shape is reads free, writes gated, which is what
`default_tools_approval_mode = "writes"` names and which only has meaning
where approval prompts exist. For the kit: add the six read tools to
`enabled_tools`, add `announce_work`, `append_update` and `import_notes` and
let `"writes"` gate them, and decide `suggest_change` and `sync_code` per
project. The interactive run showed reads passing unprompted without any
`readOnlyHint`, so the annotation is not needed for the read side; whether
`"writes"` mode prompts on the write tools is the test that decides if it
is needed for the write side.

### Shipaton

"Shipaton 2026: Seoul" on dev-korea.com, "Dev Korea: Shipaton 2026" on
shipaton.com; the "#14" the plan uses appears only in the event's URL slug,
`dev-korea-14-september-2026`, not in any title or badge. Monday
2026-09-21 at MARU180, organiser Dev Korea, hosted with RevenueCat. **16:00
KST** is the optional 모각코 doors-open; the main programme is 18:30 and the
community demos 19:30–20:00. RSVP: https://luma.com/9tuvvggu (the "Details
and sign-up" link on shipaton.com/events; 136 going and a waitlist enabled
at fetch time). Event page:
https://dev-korea.com/events/dev-korea-14-september-2026. Community demos:
*"Shipaton submissions, 5 minutes each. Sign up when you register and we'll
pick 3-4"*. Shipaton is *"RevenueCat's global hackathon for builders
shipping real apps to real stores"*; the demo slots are for those entries,
and OpenVault is not one (a self-hosted web app and MCP server, no store
listing, no subscriptions). Plan step 22 asks for something different: bring
the kit on a laptop, show the CAUTION beat to three people, and ask the
organisers for a ten-minute slot at the *next* event. The page also says
*"You don't need to be registered for Shipaton to attend."* The lookup was
done by the launching session, not by any Codex run. The owner registered on 2026-09-11 as an attendee; OpenVault is not a
Shipaton entry, so no Shipaton demo slot was requested. The agent did not
register.

### Config left in place

The full block above, plus the `d:\openvault` trust entry added tonight.
Backup of the pre-evening file in the session scratchpad.
