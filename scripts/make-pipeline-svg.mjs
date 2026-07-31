// Emit docs/pipeline.svg — the static diagram GitHub renders in the README.
//
//   node scripts/make-pipeline-svg.mjs
//
// Generated rather than hand-drawn so the coordinates cannot drift out of step
// with the flow they describe; edit STEPS and re-run. It intentionally mirrors
// src/components/PipelineScene.tsx, and carries the sub-lines the 3D scene
// drops (there, cards are ~100px wide and a second line is unreadable; here
// there is room, and a README should not need hovering).
import { writeFileSync } from "node:fs";

const LIME = "#e5ff1a";
const CYAN = "#00e5ff";
const MAGENTA = "#ff1a66";
const INK = "#0a0a0a";

// lane: 0 = your agent, 1 = the vault, 2 = their agent.
// Lane follows WHERE THE THING LIVES: the review queue is vault state, while
// approving it is an act performed by the other agent.
const STEPS = [
  { label: "YOU PROMPT", sub: "“add retries”", lane: 0, colour: LIME },
  { label: "GET_BRIEFING", sub: "state + skills", lane: 1, colour: CYAN },
  { label: "READ_CODE", sub: "mirror @ 1 commit", lane: 1, colour: CYAN },
  { label: "ANNOUNCE_WORK", sub: "warns on overlap", lane: 0, colour: LIME },
  { label: "SUGGEST_CHANGE", sub: "anchored edits", lane: 0, colour: LIME },
  { label: "REVIEW QUEUE", sub: "unreviewed, in vault", lane: 1, colour: CYAN },
  { label: "REVIEW_SUGGESTION", sub: "approve or reject", lane: 2, colour: MAGENTA },
  { label: "OWNER APPLIES", sub: "their checkout", lane: 2, colour: MAGENTA },
  { label: "CI MIRRORS", sub: "vault follows git", lane: 1, colour: CYAN },
];

const LANES = [
  { name: "YOUR AGENT", colour: LIME },
  { name: "THE VAULT", colour: CYAN },
  { name: "THEIR AGENT", colour: MAGENTA },
];

const W = 2140;
const H = 760;
const CARD_W = 184;
const CARD_H = 84;
// Pitch must clear CARD_W *and* the offset shadow, or every card sits on its
// neighbour's drop shadow and the row reads as one glued strip.
const PITCH = 204;
const X0 = 288;
const LANE_Y = [190, 370, 550];
const OFF = 7; // the hard offset shadow, in px
const PAD = 12;

const x = (i) => X0 + i * PITCH;
const y = (lane) => LANE_Y[lane];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// SVG cannot measure text, so a label longer than its card silently overflows
// into the next one — REVIEW_SUGGESTION ran straight through its neighbour.
// Size each label from its own length instead, using a conservative advance
// width for the bold sans in use.
const fit = (text, max, ideal, min, advance) =>
  Math.max(min, Math.min(ideal, Math.floor(max / (text.length * advance))));

const parts = [];
parts.push(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">`,
  `<title id="t">How work moves through OpenVault</title>`,
  `<desc id="d">A swim-lane diagram in three rows. Your agent prompts, briefs itself, reads the code mirror, announces work and proposes a change. The vault holds the code mirror and the review queue. Their agent reviews the proposal, applies the approved change in its own checkout and pushes; CI mirrors it back. The vault never writes to git.</desc>`,
  `<defs><style>
    .ttl { font: 800 17px "Segoe UI", Inter, system-ui, sans-serif; letter-spacing: .6px; fill: ${INK}; }
    .sub { font: 13px ui-monospace, "Cascadia Mono", Menlo, monospace; fill: #555; }
    .lane{ font: 800 17px "Segoe UI", Inter, system-ui, sans-serif; letter-spacing: 2.4px; fill: ${INK}; }
    .note{ font: 15px ui-monospace, "Cascadia Mono", Menlo, monospace; fill: ${INK}; }
    .hdr { font: 800 34px "Segoe UI", Inter, system-ui, sans-serif; letter-spacing: 7px; fill: ${INK}; }
    .wire{ fill: none; stroke: ${INK}; stroke-width: 3; }
  </style></defs>`,
  `<rect width="${W}" height="${H}" fill="#f5f5f5"/>`,
);

// graph paper
const rules = [];
for (let gy = 0; gy <= H; gy += 45) rules.push(`M0 ${gy} H${W}`);
for (let gx = 0; gx <= W; gx += 45) rules.push(`M${gx} 0 V${H}`);
parts.push(`<g stroke="#e7e7e7" stroke-width="1"><path d="${rules.join(" ")}"/></g>`);

// header, with the two-colour offset that is the signature of the look
parts.push(
  `<text class="hdr" x="46" y="64" fill="${CYAN}">OPENVAULT</text>`,
  `<text class="hdr" x="42" y="60" fill="${MAGENTA}">OPENVAULT</text>`,
  `<text class="hdr" x="38" y="56">OPENVAULT</text>`,
  `<text class="note" x="40" y="92">one prompt → reviewed code, and two agents on one project with no human relaying between them</text>`,
);

// lane plates
LANES.forEach((l, i) => {
  const ly = y(i) - 22;
  parts.push(
    `<rect x="${46 + OFF}" y="${ly + OFF}" width="196" height="46" fill="${INK}"/>`,
    `<rect x="46" y="${ly}" width="196" height="46" fill="${l.colour}" stroke="${INK}" stroke-width="3"/>`,
    `<text class="lane" x="64" y="${ly + 30}">${l.name}</text>`,
  );
});

// wires first, so cards sit on top of them
const wires = [];
for (let i = 0; i < STEPS.length - 1; i++) {
  const ax = x(i) + CARD_W;
  const ay = y(STEPS[i].lane) + CARD_H / 2;
  const bx = x(i + 1);
  const by = y(STEPS[i + 1].lane) + CARD_H / 2;
  const mx = (ax + bx) / 2;
  // Right angles, never diagonals: a lane change should look like a lane
  // change rather than a slope.
  wires.push(ay === by ? `M${ax} ${ay} H${bx}` : `M${ax} ${ay} H${mx} V${by} H${bx}`);
}
parts.push(`<g class="wire"><path d="${wires.join(" ")}"/></g>`);

// cards
STEPS.forEach((s, i) => {
  const cx = x(i);
  const cy = y(s.lane);
  parts.push(
    `<g>`,
    `<rect x="${cx + OFF}" y="${cy + OFF}" width="${CARD_W}" height="${CARD_H}" fill="${INK}"/>`,
    `<rect x="${cx}" y="${cy}" width="${CARD_W}" height="${CARD_H}" fill="#fff" stroke="${INK}" stroke-width="3"/>`,
    `<rect x="${cx}" y="${cy}" width="${CARD_W}" height="9" fill="${s.colour}"/>`,
    // Inline style, not a font-size attribute: the class uses the `font`
    // shorthand, and any CSS declaration outranks a presentation attribute, so
    // the attribute form was silently ignored and every label still overflowed.
    `<text class="ttl" x="${cx + PAD}" y="${cy + 42}" style="font-size:${fit(s.label, CARD_W - PAD * 2, 16, 12, 0.72)}px">${esc(s.label)}</text>`,
    `<text class="sub" x="${cx + PAD}" y="${cy + 66}" style="font-size:${fit(s.sub, CARD_W - PAD * 2, 13, 10, 0.61)}px">${esc(s.sub)}</text>`,
    `</g>`,
  );
});

// the rule underneath
const ry = H - 78;
parts.push(
  `<rect x="${46 + OFF}" y="${ry + OFF}" width="${W - 92}" height="54" fill="${INK}"/>`,
  `<rect x="46" y="${ry}" width="${W - 92}" height="54" fill="${LIME}" stroke="${INK}" stroke-width="3"/>`,
  `<text class="note" x="66" y="${ry + 33}">THE VAULT NEVER WRITES TO GIT — an agent proposes, a human disposes. That single constraint is why someone else’s agent, with no repository access at all, can safely work on your code.</text>`,
);

parts.push(`</svg>`);
writeFileSync("docs/pipeline.svg", parts.join("\n") + "\n");
console.log(`docs/pipeline.svg — ${STEPS.length} steps, ${W}×${H}`);
