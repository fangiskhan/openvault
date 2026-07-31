// Screenshot the running app, for the README.
//
//   node scripts/shoot.mjs [baseUrl] [outDir]
//
// Drives headless Chrome over the DevTools Protocol using Node's built-in
// WebSocket — no Playwright, no Puppeteer, no browser download. The vault is
// password-gated, so it signs in first and injects the session cookie before
// navigating; otherwise every shot would be of the login screen.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:6900";
const OUT = process.argv[3] ?? "docs/screenshots";
const PORT = 9333;
const W = 1440;
const H = 900;

const CHROME = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));
if (!CHROME) {
  console.error("no Chrome or Edge found — install one, or set the path in scripts/shoot.mjs");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sign in over HTTP and keep the cookie, so the browser lands authenticated.
const password = process.env.OV_PASSWORD ?? process.env.APP_PASSWORD ?? "";
let cookie = null;
if (password) {
  const res = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const raw = (res.headers.getSetCookie?.() ?? [])[0];
  if (raw) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
  }
  console.log(`sign-in: HTTP ${res.status}${cookie ? ` (cookie ${cookie.name})` : " (no cookie returned)"}`);
}

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2", // retina-ish output, so the README images stay crisp
    `--window-size=${W},${H}`,
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=" + join(process.env.TEMP ?? "/tmp", `ov-shoot-${Date.now()}`),
    "about:blank",
  ],
  { stdio: "ignore" },
);

// Wait for the debugging endpoint rather than guessing at a sleep duration.
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250);
  try {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  } catch {
    /* not up yet */
  }
}
if (!target) {
  chrome.kill();
  console.error("Chrome did not expose a debugging target");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});

let nextId = 1;
const pending = new Map();
const events = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) {
    events.push(msg.method);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
if (cookie) {
  const url = new URL(BASE);
  await send("Network.setCookie", { name: cookie.name, value: cookie.value, domain: url.hostname, path: "/" });
}

mkdirSync(OUT, { recursive: true });

// Each shot: navigate, let the app settle, optionally run a snippet to open a
// tab or panel, then capture.
const shots = [
  { file: "01-notes.png", path: "/", label: "Notes — the vault at rest" },
  { file: "02-status.png", path: "/", label: "Status board", click: "Status" },
  { file: "03-code.png", path: "/", label: "Code mirror + review queue", click: "Code" },
  { file: "04-graph.png", path: "/", label: "Arc diagram of the whole vault", click: "Graph" },
  { file: "05-pipeline.png", path: "/pipeline", label: "How it works (3D pipeline)", settle: 2600 },
];

for (const s of shots) {
  await send("Page.navigate", { url: `${BASE}${s.path}` });
  await sleep(s.settle ?? 1800);
  if (s.click) {
    // Click a top-level tab by its visible label, then let it render.
    await send("Runtime.evaluate", {
      expression: `(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(s.click)});
        if (b) b.click();
        return !!b;
      })()`,
    });
    await sleep(1500);
  }
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const out = join(OUT, s.file);
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`  ${s.file.padEnd(18)} ${String(Buffer.from(data, "base64").length).padStart(8)}B  ${s.label}`);
}

ws.close();
chrome.kill();
console.log(`\n${shots.length} screenshot(s) -> ${OUT}`);
