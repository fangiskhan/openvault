"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Node = { id: string; label: string; type: string; projectId: string; createdAt: string; color: string };
type Edge = { source: string; target: string };
type ProjectRef = { id: string; name: string; color: string };
type GraphData = { nodes: Node[]; edges: Edge[]; inferred?: Edge[]; projects: ProjectRef[] };

// Arc diagram of the vault's links, in the tradition of Harrison & Römhild's
// Bible cross-reference plot. The x-axis carries meaning — notes grouped by
// project, ordered by age within it — so an arc that leaves its colour band IS
// a cross-project connection. Density becomes structure instead of a hairball,
// and the result reads as a single image (which is what gets shared).

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [139, 124, 246];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export default function ArcView({
  projectId,
  scope = "all",
  onOpen,
}: {
  projectId: string;
  scope?: string;
  onOpen: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Opens on the whole vault: cross-project sweeps are the point of this view.
  const [gscope, setGscope] = useState(scope);
  const [crossOnly, setCrossOnly] = useState(false);
  const [showInferred, setShowInferred] = useState(true);
  const [hover, setHover] = useState<{ x: number; node: Node } | null>(null);

  const fetchKey = `${projectId}|${gscope}`;
  const [fetched, setFetched] = useState<{ key: string; graph: GraphData } | null>(null);
  const data = fetched?.key === fetchKey ? fetched.graph : null;

  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    let cancelled = false;
    const key = `${projectId}|${gscope}`;
    fetch(`/api/graph?projectId=${encodeURIComponent(projectId)}&scope=${gscope}&inferred=1`)
      .then((r) => r.json())
      .then((g: GraphData) => !cancelled && setFetched({ key, graph: g }))
      .catch(() => !cancelled && setFetched({ key, graph: { nodes: [], edges: [], projects: [] } }));
    return () => {
      cancelled = true;
    };
  }, [projectId, gscope]);

  // Layout and paint are separated because the view animates now: the geometry
  // only changes when the data, the filters or the canvas size change, while
  // the frame loop runs continuously. Recomputing the sort and the arc list
  // sixty times a second would be pure waste.
  type Arc = {
    s: string;
    t: string;
    x1: number;
    x2: number;
    kind: "explicit" | "inferred";
    cross: boolean;
    span: number;
    color: string;
  };
  type Scene = {
    ordered: Node[];
    xOf: Map<string, number>;
    neighbours: Map<string, Set<string>>;
    arcs: Arc[];
    angleLut: Float64Array;
    glowScale: number;
    degree: Map<string, number>;
    maxDeg: number;
    baseY: number;
    barH: number;
    padX: number;
    step: number;
    squash: number;
    W: number;
    H: number;
  };
  const sceneRef = useRef<Scene | null>(null);
  // The hovered id is read by the frame loop, so it lives in a ref as well as
  // in state: putting it only in state would rebuild the loop on every mouse
  // move, and putting it only in a ref would never re-render the tooltip.
  const hoverIdRef = useRef<string | null>(null);

  const build = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width;
    const H = rect.height;
    if (!data.nodes.length) {
      sceneRef.current = null;
      return;
    }

    const order = new Map(data.projects.map((p, i) => [p.id, i]));
    const ordered = [...data.nodes].sort((a, b) => {
      const pa = order.get(a.projectId) ?? 999;
      const pb = order.get(b.projectId) ?? 999;
      if (pa !== pb) return pa - pb;
      const t = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return t !== 0 ? t : a.id.localeCompare(b.id);
    });

    const padX = 14;
    const barH = Math.min(90, H * 0.22);
    const baseY = H - barH - 10;
    const usable = W - padX * 2;
    const step = usable / Math.max(1, ordered.length - 1 || 1);
    const xOf = new Map<string, number>();
    ordered.forEach((n, i) => xOf.set(n.id, padX + (ordered.length === 1 ? usable / 2 : i * step)));

    const projectOf = new Map(data.nodes.map((n) => [n.id, n.projectId]));
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const maxDeg = Math.max(1, ...degree.values());

    const colorOf = new Map(data.nodes.map((n) => [n.id, n.color]));
    const prep = (list: Edge[], kind: "explicit" | "inferred"): Arc[] =>
      list
        .filter((e) => xOf.has(e.source) && xOf.has(e.target))
        .map((e) => ({
          s: e.source,
          t: e.target,
          x1: xOf.get(e.source)!,
          x2: xOf.get(e.target)!,
          kind,
          cross: projectOf.get(e.source) !== projectOf.get(e.target),
          span: Math.abs(xOf.get(e.target)! - xOf.get(e.source)!),
          color: colorOf.get(e.source) ?? "#8b7cf6",
        }))
        .filter((e) => (crossOnly ? e.cross : true));

    const arcs = [
      ...(showInferred ? prep(data.inferred ?? [], "inferred") : []),
      ...prep(data.edges, "explicit"),
    ].sort((a, b) => a.span - b.span); // long sweeps paint last, on top

    // Adjacency over the arcs actually on screen, so focusing a note respects
    // the current filters rather than the raw graph.
    const neighbours = new Map<string, Set<string>>();
    for (const a of arcs) {
      if (!neighbours.has(a.s)) neighbours.set(a.s, new Set());
      if (!neighbours.has(a.t)) neighbours.set(a.t, new Set());
      neighbours.get(a.s)!.add(a.t);
      neighbours.get(a.t)!.add(a.s);
    }

    // Additive light saturates with density, and this vault draws ~600 explicit
    // arcs plus ~700 inferred. At full strength the dense half of the diagram
    // burns out to flat white and the structure — which is the entire point of
    // an arc plot — disappears. So the bloom is attenuated by how many arcs are
    // actually competing for the same pixels.
    const explicitCount = arcs.reduce((n2, a) => n2 + (a.kind === "explicit" ? 1 : 0), 0);
    const glowScale = Math.max(0.12, Math.min(1, 140 / Math.max(1, explicitCount)));

    // Even spacing along an ELLIPSE needs more than even spacing in angle:
    // stepping theta uniformly is constant-speed only on a circle, and these
    // arcs run at a squash of roughly 0.89, so a dot would cover ~12% more
    // ground per frame at the apex than at the ends. Since every arc is the
    // same ellipse scaled, one lookup table serves all of them: length
    // fraction in, angle fraction out.
    const squash = Math.min(1, (baseY - 12) / Math.max(1, usable / 2));
    const LUT = 64;
    const angleLut = new Float64Array(LUT + 1);
    {
      const M = 512;
      const cum = new Float64Array(M + 1);
      let px = Math.cos(Math.PI);
      let py = squash * Math.sin(Math.PI);
      for (let m = 1; m <= M; m++) {
        const th = Math.PI + (m / M) * Math.PI;
        const cxx = Math.cos(th);
        const cyy = squash * Math.sin(th);
        cum[m] = cum[m - 1] + Math.hypot(cxx - px, cyy - py);
        px = cxx;
        py = cyy;
      }
      const total = cum[M] || 1;
      let m = 1;
      for (let j = 0; j <= LUT; j++) {
        const target = (j / LUT) * total;
        while (m < M && cum[m] < target) m++;
        const c0 = cum[m - 1];
        const c1 = cum[m];
        const f = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
        angleLut[j] = (m - 1 + f) / M;
      }
    }

    sceneRef.current = {
      ordered,
      xOf,
      neighbours,
      arcs,
      angleLut,
      glowScale,
      degree,
      maxDeg,
      baseY,
      barH,
      padX,
      step,
      squash,
      W,
      H,
    };
  }, [data, crossOnly, showInferred]);

  // A point on the arc, as a fraction of the way from source to target. The
  // arcs are drawn as the upper half of an ellipse, so the parameter is an
  // angle from PI to 2PI; travelling source-to-target means running it
  // backwards when the source sits to the right of the target.
  // `back` sends the packet the other way down the same wire. Traffic runs in
  // both directions because a link between two notes is not one-way — each end
  // cites the other — and a single direction read as a conveyor belt rather
  // than a conversation.
  const pointOn = (a: Arc, u: number, baseY: number, squash: number, back: boolean, lut: Float64Array) => {
    const cx = (a.x1 + a.x2) / 2;
    const rx = a.span / 2;
    const along = back ? 1 - u : u;
    const forward = a.x1 <= a.x2 ? along : 1 - along;
    // `forward` is a fraction of ARC LENGTH; the table converts it to the
    // fraction of angle that lands there.
    const t = Math.max(0, Math.min(0.999999, forward)) * (lut.length - 1);
    const i0 = Math.floor(t);
    const frac = t - i0;
    const af = lut[i0] + (lut[Math.min(lut.length - 1, i0 + 1)] - lut[i0]) * frac;
    const ang = Math.PI + af * Math.PI;
    return { x: cx + rx * Math.cos(ang), y: baseY + rx * squash * Math.sin(ang) };
  };

  useEffect(() => {
    build();
    const onResize = () => build();
    window.addEventListener("resize", onResize);

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    // An animation nobody can opt out of is a bug. Honour the OS setting: the
    // diagram still works as a still image, it just stops sending packets.
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    // Constant SPEED, not constant duration. Giving every arc the same period
    // meant a long cross-project sweep covered several times the distance of a
    // short hop in the same time, so packets appeared to race on the big arcs
    // and crawl on the small ones. Period is derived from arc length instead.
    const SPEED = 95; // px per second, the same on every wire
    // Ramanujan's ellipse perimeter, halved: these arcs are the upper half of
    // an ellipse, and the earlier 1.6*(rx+ry) guess was wrong enough to matter
    // once length started driving timing rather than just dot spacing.
    const arcLength = (a: number, b: number) =>
      (Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))) / 2;

    // Bloom, the cheap and correct way. Everything luminous is drawn a second
    // time into a half-resolution buffer, blurred once, and composited back
    // with `lighter` (additive). Two things fall out of that for free:
    // overlapping arcs ADD, so a dense crossing burns brighter than a lone
    // strand and the plane reads as having depth; and the light bleeds past
    // its geometry, which is what makes a 1px stroke look like a lit filament
    // rather than a drawn line.
    //
    // Per-shape ctx.shadowBlur would give a similar look and is the obvious
    // first idea, but it re-blurs on every stroke — hundreds of gaussian
    // passes a frame. One buffer, one blur.
    const glowBuf = document.createElement("canvas");
    const gctx = glowBuf.getContext("2d");
    const GS = 0.5; // glow buffer scale; blurring at half res is free softness

    // The plate the arcs are drawn on. A canvas cannot take a CSS background,
    // so it is painted as the first thing each frame; until it decodes, the
    // flat ink colour stands in, which is what the view looked like before.
    const plate = new Image();
    let plateReady = false;
    plate.onload = () => {
      plateReady = true;
    };
    plate.src = "/bg/game_box_background.webp";

    let raf = 0;
    const paint = (now: number) => {
      raf = requestAnimationFrame(paint);
      const sc = sceneRef.current;
      if (!ctx || !canvas) return;
      ctx.globalCompositeOperation = "source-over";
      ctx.filter = "none";
      const cw = sc?.W ?? canvas.width;
      const ch = sc?.H ?? canvas.height;
      ctx.fillStyle = "#070709";
      ctx.fillRect(0, 0, cw, ch);
      if (plateReady) {
        // Cover-fit and centre: the plate is square and the stage is wide, so
        // scaling to fit would letterbox it against the ink.
        const s = Math.max(cw / plate.width, ch / plate.height);
        const dw = plate.width * s;
        const dh = plate.height * s;
        ctx.drawImage(plate, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
        // Knock it back so the arcs stay the brightest thing on the stage —
        // it is scenery, and additive glow over a busy plate loses contrast.
        ctx.fillStyle = "rgba(7,7,9,0.45)";
        ctx.fillRect(0, 0, cw, ch);
      }
      if (!sc) return;

      const focus = hoverIdRef.current;
      const near = focus ? sc.neighbours.get(focus) : null;
      // Focus mode draws a handful of arcs instead of hundreds, so the light
      // can go back up to full — which is what makes hovering feel like
      // switching a circuit on rather than merely filtering a list.
      const lit = focus ? 1 : sc.glowScale;

      if (glowBuf.width !== Math.round(sc.W * GS) || glowBuf.height !== Math.round(sc.H * GS)) {
        glowBuf.width = Math.round(sc.W * GS);
        glowBuf.height = Math.round(sc.H * GS);
      }
      if (gctx) {
        gctx.setTransform(GS, 0, 0, GS, 0, 0);
        gctx.clearRect(0, 0, sc.W, sc.H);
        gctx.lineCap = "round";
        gctx.globalCompositeOperation = "lighter";
      }
      ctx.lineCap = "round";

      // Pass 1 — geometry, drawn into both the crisp layer and the glow buffer.
      const dots: Array<{ x: number; y: number; hot: number; weak: boolean }> = [];
      sc.arcs.forEach((e, i) => {
        const rx = e.span / 2;
        if (rx < 0.5) return;
        // Focus mode: only the hovered note's own arcs survive. Everything
        // else is removed rather than dimmed — a faint arc still reads as a
        // connection, which is exactly the confusion this is meant to clear.
        const mine = !focus || e.s === focus || e.t === focus;
        if (focus && !mine) return;

        const [r, g, b] = hexToRgb(e.color);
        const base = e.kind === "inferred" ? (e.cross ? 0.2 : 0.08) : e.cross ? 0.6 : 0.26;
        const alpha = focus ? Math.min(1, base * 2.2 + 0.25) : base;
        const width = (e.kind === "inferred" ? 0.7 : e.cross ? 1.5 : 0.9) * (focus ? 1.6 : 1);
        const cx = (e.x1 + e.x2) / 2;

        const arcPath = (c: CanvasRenderingContext2D) => {
          c.beginPath();
          c.ellipse(cx, sc.baseY, rx, rx * sc.squash, 0, Math.PI, Math.PI * 2);
          c.stroke();
        };

        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth = width;
        arcPath(ctx);

        // Only explicit links are lit. The inferred weave is 700-odd arcs of
        // "these two notes share vocabulary" — glowing them contributed most
        // of the white-out and none of the meaning, so they stay as unlit
        // thread in the crisp layer.
        if (gctx && e.kind === "explicit") {
          // Fatter and brighter in the glow buffer: the blur is what turns
          // this into diffusion rather than a second, thicker line.
          gctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(1, alpha * 0.42 * lit)})`;
          gctx.lineWidth = width * (focus ? 2.4 : 1.8);
          arcPath(gctx);
        }

        // The travelling dot: a note handing something to the note it links to.
        // Inferred arcs stay quiet — they are a suggestion, not traffic — and
        // staggering by the golden ratio keeps the dots from marching in step.
        if (still) return;
        // Inferred links carry traffic too, but thinner and fainter: they are
        // "these two notes share vocabulary", a weaker claim than "this note
        // cites that one", and the animation should say so. Sparser spacing
        // and a lower cap keep the weaker channel visually subordinate — and
        // keep the frame budget sane, since inferred arcs outnumber explicit
        // ones here (716 to 595).
        const weak = e.kind === "inferred";
        const arcLen = arcLength(rx, rx * sc.squash);
        const count = Math.max(1, Math.min(weak ? 3 : 6, Math.round(arcLen / (weak ? 190 : 105))));
        // Seconds to cross THIS arc at the shared speed. Weak links used to run
        // slower as a second weakness cue; that reintroduced exactly the uneven
        // pace this change removes, and brightness, size and density already
        // carry the signal.
        const period = Math.max(0.4, arcLen / SPEED);
        for (let k = 0; k < count; k++) {
          const u = (now / 1000 / period + ((i * 0.6180339887) % 1) + k / count) % 1;
          // Alternate direction per dot: two-way traffic for free, rather than
          // doubling the dot count to get a second stream.
          const p = pointOn(e, u, sc.baseY, sc.squash, k % 2 === 1, sc.angleLut);
          dots.push({ x: p.x, y: p.y, hot: (focus ? 1 : 0.75) * (weak ? 0.4 : 1), weak });
        }
      });

      // Bars, also lit.
      for (const n of sc.ordered) {
        const x = sc.xOf.get(n.id)!;
        const d = sc.degree.get(n.id) ?? 0;
        const h = 6 + (d / sc.maxDeg) * (sc.barH - 10);
        const [r, g, b] = hexToRgb(n.color);
        const related = !focus || n.id === focus || near?.has(n.id);
        // Unconnected notes stay faintly visible rather than going black: the
        // left-to-right ordering IS the x-axis, and blanking it entirely
        // removes the context that makes a connection meaningful.
        const a = focus ? (n.id === focus ? 1 : related ? 0.9 : 0.2) : d ? 0.9 : 0.35;
        const bx = x - Math.max(0.6, sc.step * 0.35);
        const bw = Math.max(1.2, sc.step * 0.7);
        ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
        ctx.fillRect(bx, sc.baseY + 2, bw, h);
        if (gctx && a > 0.3) {
          gctx.fillStyle = `rgba(${r},${g},${b},${a * 0.7 * lit})`;
          gctx.fillRect(bx - bw * 0.5, sc.baseY + 2, bw * 2, h);
        }
      }

      // Dots last so their light sits on top of every arc.
      for (const p of dots) {
        // Weak-link packets get no halo at all — only explicit traffic is lit.
        // That is both the honest signal (a lit wire means a real citation)
        // and what keeps ~700 inferred arcs from costing a second glow pass.
        if (gctx && !p.weak) {
          // A small, tight halo. With several dots per arc a wide one merges
          // its neighbours into a glowing rope, which loses the very thing the
          // dots are for — the sense of discrete packets in motion.
          gctx.fillStyle = `rgba(255,255,255,${0.5 * p.hot * Math.max(0.5, lit)})`;
          gctx.beginPath();
          gctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
          gctx.fill();
        }
        // One crisp core, no mid halo: the bloom pass supplies the softness.
        // Back to the pre-shrink radii — the dialog is a third wider now, so
        // the same dot covers proportionally less of the stage than it did.
        ctx.fillStyle = `rgba(255,255,255,${0.92 * p.hot})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.weak ? 0.9 : 1.3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Pass 2 — the bloom itself. Two composites at different radii: a tight
      // one for the filament's core heat, a wide one for the haze around it.
      if (gctx) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.filter = "blur(3px)";
        ctx.globalAlpha = 0.34;
        ctx.drawImage(glowBuf, 0, 0, sc.W, sc.H);
        ctx.filter = "blur(12px)";
        ctx.globalAlpha = 0.2;
        ctx.drawImage(glowBuf, 0, 0, sc.W, sc.H);
        ctx.restore();
      }

      ctx.globalCompositeOperation = "source-over";
      ctx.filter = "none";
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sc.padX, sc.baseY + 1.5);
      ctx.lineTo(sc.W - sc.padX, sc.baseY + 1.5);
      ctx.stroke();
    };
    raf = requestAnimationFrame(paint);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [build]);

  // Returns the note under the cursor plus its canvas-relative x, so the
  // tooltip can be positioned without reading a ref during render.
  const nodeAt = (clientX: number, clientY: number): { node: Node; x: number } | null => {
    const canvas = canvasRef.current;
    const sc = sceneRef.current;
    if (!canvas || !sc) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (y < sc.baseY - 6) return null; // only the baseline strip is interactive
    let best: Node | null = null;
    let bestD = 8;
    for (const n of sc.ordered) {
      const d = Math.abs((sc.xOf.get(n.id) ?? -999) - x);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best ? { node: best, x } : null;
  };

  // Both, deliberately: the ref drives the frame loop without re-rendering on
  // every mouse move, the state drives the tooltip.
  const setHovered = (hit: { node: Node; x: number } | null) => {
    hoverIdRef.current = hit?.node.id ?? null;
    setHover(hit ? { x: hit.x, node: hit.node } : null);
  };

  const counts = data
    ? {
        notes: data.nodes.length,
        links: data.edges.length,
        cross: data.edges.filter((e) => {
          const p = new Map(data.nodes.map((n) => [n.id, n.projectId]));
          return p.get(e.source) !== p.get(e.target);
        }).length,
        inferred: data.inferred?.length ?? 0,
      }
    : null;

  return (
    <div className="graph-wrap">
      <div className="graph-controls">
        <div className="scope">
          {["project", "connected", "all"].map((s) => (
            <button key={s} className={gscope === s ? "on" : ""} onClick={() => setGscope(s)}>
              {s === "project" ? "This project" : s === "connected" ? "Connected" : "All"}
            </button>
          ))}
        </div>
        <button className={`btn${crossOnly ? " btn-accent" : ""}`} onClick={() => setCrossOnly((v) => !v)}>
          {crossOnly ? "Cross-project only" : "All links"}
        </button>
        <button className={`btn${showInferred ? " btn-accent" : ""}`} onClick={() => setShowInferred((v) => !v)}>
          Inferred {showInferred ? "on" : "off"}
        </button>
        {counts && (
          <span className="graph-count">
            {counts.notes} notes · {counts.links} links · {counts.cross} cross-project
            {counts.inferred ? ` · ${counts.inferred} inferred` : ""}
          </span>
        )}
      </div>
      <div className="graph-stage">
        <canvas
          ref={canvasRef}
          className="arc-canvas"
          onMouseMove={(e) => setHovered(nodeAt(e.clientX, e.clientY))}
          onMouseLeave={() => setHovered(null)}
          onClick={(e) => {
            const hit = nodeAt(e.clientX, e.clientY);
            if (hit) onOpenRef.current(hit.node.id);
          }}
        />
        {data && data.nodes.length === 0 && (
          <div className="graph-empty">
            <p className="empty">No notes in this scope yet.</p>
          </div>
        )}
        {/* Legend and hover read-out share one top-anchored column, so the
            read-out always lands directly under the legend however many rows
            the legend wraps to. It used to be positioned at the cursor's x
            along the bottom, which meant a title hovered near the right edge
            was clipped by the stage — the further right, the more was lost. */}
        <div className="arc-top">
          <div className="graph-legend arc-legend">
            <div className="graph-legend-title">Projects (left to right)</div>
            {data?.projects.map((p) => (
              <div key={p.id} className="graph-legend-item">
                <span className="cdot" style={{ background: p.color }} />
                <span className="truncate">{p.name}</span>
              </div>
            ))}
          </div>
          {hover && (
            <div className="arc-tip">
              <span className="cdot" style={{ background: hover.node.color }} /> {hover.node.label}
            </div>
          )}
        </div>
      </div>
      <p className="empty">
        Notes run left to right grouped by project, oldest first. Each arc is a link; the taller it reaches, the
        farther apart the notes sit — so every arc that leaves its colour band connects two different projects. Bars
        show how many links a note carries. Click a bar to open its note.
      </p>
    </div>
  );
}
