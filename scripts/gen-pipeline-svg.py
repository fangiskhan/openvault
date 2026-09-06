# -*- coding: utf-8 -*-
import io

W, H = 960, 1326
INK, BG, SUB = "#0a0a0a", "#f5f5f5", "#555"
LIME, CYAN, MAG, GREY = "#e5ff1a", "#00e5ff", "#ff1a66", "#d4d4d4"

# columns
C1, C2, C3, C4 = 24, 282, 540, 798
CW, C4W = 234, 138
CEN = {1: C1 + CW // 2, 2: C2 + CW // 2, 3: C3 + CW // 2, 4: C4 + C4W // 2}

HDR_Y, HDR_H = 156, 46
BAND_TOP, BAND_BOT = 156, 1231
ROW0, ROWGAP, BH = 284, 112, 74


def cy(i):
    return ROW0 + (i - 1) * ROWGAP


def top(i):
    return cy(i) - BH // 2


def bot(i):
    return cy(i) + BH // 2


o = []
a = o.append

a(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d">')
a('<title id="t">How a change reaches your repo through OpenVault</title>')
a('<desc id="d">A nine-step flow in four vertical lanes: the contributor, the vault, the owner, and git. '
  'The contributor prompts an agent, which reads a briefing, reads the code mirror, announces the work it plans, '
  'and files an anchored suggestion. The vault holds that suggestion in a review queue. The owner approves it, '
  'applies it in their own checkout and pushes to git. CI syncs the repository back into the mirror. '
  'A crossed-out line marks the one path that does not exist: the vault never writes to git.</desc>')

a('<defs>')
a('<style>'
  '.hdr{font:800 32px "Segoe UI",Inter,system-ui,sans-serif;letter-spacing:6px;fill:#0a0a0a}'
  '.sub{font:13px ui-monospace,"Cascadia Mono",Menlo,monospace;fill:#0a0a0a}'
  '.lane{font:800 15px "Segoe UI",Inter,system-ui,sans-serif;letter-spacing:2.2px;fill:#0a0a0a}'
  '.lanesub{font:11px ui-monospace,"Cascadia Mono",Menlo,monospace;fill:#555}'
  '.ttl{font:800 14px "Segoe UI",Inter,system-ui,sans-serif;letter-spacing:.5px;fill:#0a0a0a}'
  '.det{font:11.5px ui-monospace,"Cascadia Mono",Menlo,monospace;fill:#555}'
  '.num{font:800 15px "Segoe UI",Inter,system-ui,sans-serif;fill:#fff}'
  '.foot{font:13px ui-monospace,"Cascadia Mono",Menlo,monospace;fill:#0a0a0a}'
  '.never{font:800 13px "Segoe UI",Inter,system-ui,sans-serif;letter-spacing:2px;fill:#ff1a66}'
  '.wire{fill:none;stroke:#0a0a0a;stroke-width:3}'
  '</style>')
a('<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
  '<path d="M0 0 L10 5 L0 10 z" fill="#0a0a0a"/></marker>')
a('<marker id="ahg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">'
  '<path d="M0 0 L10 5 L0 10 z" fill="#9a9a9a"/></marker>')
a('</defs>')

a(f'<rect width="{W}" height="{H}" fill="{BG}"/>')

# faint grid, same texture as the rest of the site
g = []
for x in range(0, W + 1, 48):
    g.append(f"M{x} 0 V{H}")
for y in range(0, H + 1, 48):
    g.append(f"M0 {y} H{W}")
a(f'<g stroke="#e7e7e7" stroke-width="1"><path d="{" ".join(g)}"/></g>')

# lane bands: the vault is the medium everything passes through; git sits outside it
a(f'<rect x="{C2}" y="{BAND_TOP}" width="{CW}" height="{BAND_BOT - BAND_TOP}" fill="{CYAN}" opacity="0.10"/>')
a(f'<rect x="{C4}" y="{BAND_TOP}" width="{C4W}" height="{BAND_BOT - BAND_TOP}" fill="{INK}" opacity="0.05"/>')

# header
a(f'<rect x="31" y="29" width="296" height="52" fill="{INK}"/>')
a(f'<rect x="24" y="22" width="296" height="52" fill="{LIME}" stroke="{INK}" stroke-width="3"/>')
a('<text class="hdr" x="42" y="59">OPENVAULT</text>')
a('<text class="sub" x="24" y="106">One prompt reaches your repo as a reviewed change, and nobody relays a message.</text>')
a(f'<text class="sub" x="24" y="128" fill="{SUB}">The contributor cannot push. Their agent proposes; you approve; you push.</text>')


def plate(x, y, w, h, fill, label, sublabel):
    a(f'<rect x="{x+7}" y="{y+7}" width="{w}" height="{h}" fill="{INK}"/>')
    a(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" stroke="{INK}" stroke-width="3"/>')
    a(f'<text class="lane" x="{x+16}" y="{y+29}">{label}</text>')
    a(f'<text class="lanesub" x="{x}" y="{y+HDR_H+22}">{sublabel}</text>')


plate(C1, HDR_Y, CW, HDR_H, LIME, "CONTRIBUTOR", "cannot push to your repo")
plate(C2, HDR_Y, CW, HDR_H, CYAN, "THE VAULT", "shared memory")
plate(C3, HDR_Y, CW, HDR_H, MAG, "OWNER", "reviews, then pushes")
plate(C4, HDR_Y, C4W, HDR_H, GREY, "GIT", "your repo")


def node(col, row, accent, num, title, detail):
    x = C1 + (col - 1) * 258 if col < 4 else C4
    w = CW if col < 4 else C4W
    y = top(row)
    a(f'<g><rect x="{x+7}" y="{y+7}" width="{w}" height="{BH}" fill="{INK}"/>')
    a(f'<rect x="{x}" y="{y}" width="{w}" height="{BH}" fill="#fff" stroke="{INK}" stroke-width="3"/>')
    a(f'<rect x="{x}" y="{y}" width="{w}" height="9" fill="{accent}"/>')
    if num:
        a(f'<rect x="{x+10}" y="{y+22}" width="26" height="26" fill="{INK}"/>')
        a(f'<text class="num" x="{x+23}" y="{y+40}" text-anchor="middle">{num}</text>')
        tx = x + 48
    else:
        tx = x + 16
    a(f'<text class="ttl" x="{tx}" y="{y+40}">{title}</text>')
    a(f'<text class="det" x="{tx}" y="{y+61}">{detail}</text></g>')


STEPS = [
    (1, 1, LIME, "1", "THE PROMPT", "&#8220;add retries&#8221;"),
    (1, 2, LIME, "2", "GET_BRIEFING", "state + project skills"),
    (1, 3, LIME, "3", "READ_CODE", "mirror at one commit"),
    (1, 4, LIME, "4", "ANNOUNCE_WORK", "warns on overlap"),
    (1, 5, LIME, "5", "SUGGEST_CHANGE", "anchored edits + reason"),
    # the review queue and git are PLACES, not steps anyone takes, so they carry
    # no number. That also keeps this diagram at the same 8 steps as /pipeline.
    (2, 6, CYAN, "", "REVIEW QUEUE", "held until you rule"),
    (3, 7, MAG, "6", "REVIEW_SUGGESTION", "approve or reject"),
    (3, 8, MAG, "7", "APPLY AND PUSH", "in your own checkout"),
    (2, 9, CYAN, "8", "CI SYNCS BACK", "mirror = that commit"),
]
for col, row, accent, num, title, detail in STEPS:
    node(col, row, accent, num, title, detail)

# git, sitting outside the vault, level with the push that reaches it
node(4, 8, GREY, "", "GIT", "")

ANSWERS = {
    2: "briefing built from items",
    3: "no git pull needed",
    4: "names who else is in there",
    5: "each anchor must match once",
}
for row, text in ANSWERS.items():
    a(f'<path d="M{C1+CW} {cy(row)} H{C2}" fill="none" stroke="#9a9a9a" stroke-width="2" marker-end="url(#ahg)"/>')
    a(f'<text class="det" x="{C2+16}" y="{cy(row)+4}">{text}</text>')

x1, x2, x3 = CEN[1], CEN[2], CEN[3]
wires = [
    f"M{x1} {bot(1)} V{top(2)}",
    f"M{x1} {bot(2)} V{top(3)}",
    f"M{x1} {bot(3)} V{top(4)}",
    f"M{x1} {bot(4)} V{top(5)}",
    f"M{x1} {bot(5)} V{bot(5)+18} H{x2} V{top(6)}",
    f"M{x2} {bot(6)} V{bot(6)+18} H{x3} V{top(7)}",
    f"M{x3} {bot(7)} V{top(8)}",
    f"M{C3+CW} {cy(8)} H{C4}",
    f"M{CEN[4]} {bot(8)} V{bot(8)+19} H{x2} V{top(9)}",
]
for w in wires:
    a(f'<path class="wire" d="{w}" marker-end="url(#ah)"/>')

# the one path that does not exist
by = cy(6)
a(f'<path d="M{C2+CW} {by} H{C4}" fill="none" stroke="{MAG}" stroke-width="3" stroke-dasharray="9 7"/>')
bx = (C2 + CW + C4) // 2
a(f'<circle cx="{bx}" cy="{by}" r="17" fill="{BG}"/>')
a(f'<path d="M{bx-9} {by-9} L{bx+9} {by+9} M{bx+9} {by-9} L{bx-9} {by+9}" stroke="{MAG}" stroke-width="5" stroke-linecap="square"/>')
a(f'<text class="never" x="{bx}" y="{by-27}" text-anchor="middle">NEVER</text>')

# footer
FY = 1256
a(f'<rect x="{C1+7}" y="{FY+7}" width="912" height="46" fill="{INK}"/>')
a(f'<rect x="{C1}" y="{FY}" width="912" height="46" fill="{LIME}" stroke="{INK}" stroke-width="3"/>')
a(f'<text class="foot" x="{C1+18}" y="{FY+29}">'
  'The vault stores no git credential. Nothing lands in your repo that you did not approve and push yourself.'
  '</text>')

a('</svg>')

io.open("D:/openvault/docs/pipeline.svg", "w", encoding="utf-8", newline="\n").write("\n".join(o) + "\n")
print("wrote docs/pipeline.svg", len("\n".join(o)), "bytes")
