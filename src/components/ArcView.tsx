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
  scope,
  onOpen,
}: {
  projectId: string;
  scope: string;
  onOpen: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gscope, setGscope] = useState(scope === "project" ? "all" : scope);
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

  // Layout: stable ordering is the whole point, so sort projects by name and
  // notes by creation time. Kept in a ref for the hit-test on click/hover.
  const layoutRef = useRef<{ ordered: Node[]; xOf: Map<string, number>; baseY: number; w: number } | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width;
    const H = rect.height;

    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, W, H);
    if (!data.nodes.length) return;

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
    layoutRef.current = { ordered, xOf, baseY, w: W };

    const projectOf = new Map(data.nodes.map((n) => [n.id, n.projectId]));
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const maxDeg = Math.max(1, ...degree.values());

    // Arcs: short intra-project hops sit low, cross-project links sweep high —
    // so the eye reads reach as relatedness across the whole vault.
    const colorOf = new Map(data.nodes.map((n) => [n.id, n.color]));
    const prep = (list: Edge[], kind: "explicit" | "inferred") =>
      list
        .filter((e) => xOf.has(e.source) && xOf.has(e.target))
        .map((e) => {
          const x1 = xOf.get(e.source)!;
          const x2 = xOf.get(e.target)!;
          return {
            x1,
            x2,
            kind,
            cross: projectOf.get(e.source) !== projectOf.get(e.target),
            span: Math.abs(x2 - x1),
            color: colorOf.get(e.source) ?? "#8b7cf6",
          };
        })
        .filter((e) => (crossOnly ? e.cross : true));

    const edges = [
      ...(showInferred ? prep(data.inferred ?? [], "inferred") : []),
      ...prep(data.edges, "explicit"),
    ].sort((a, b) => a.span - b.span); // long sweeps paint last, on top

    const maxR = usable / 2;
    const squash = Math.min(1, (baseY - 12) / Math.max(1, maxR));

    ctx.lineCap = "round";
    for (const e of edges) {
      const cx = (e.x1 + e.x2) / 2;
      const rx = e.span / 2;
      if (rx < 0.5) continue;
      const [r, g, b] = hexToRgb(e.color);
      // Explicit links read solid; inferred ones sit behind as a faint weave.
      // Cross-project arcs are the story either way, so they get more presence.
      const alpha =
        e.kind === "inferred" ? (e.cross ? 0.2 : 0.08) : e.cross ? 0.6 : 0.26;
      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.lineWidth = e.kind === "inferred" ? 0.7 : e.cross ? 1.5 : 0.9;
      ctx.beginPath();
      ctx.ellipse(cx, baseY, rx, rx * squash, 0, Math.PI, Math.PI * 2);
      ctx.stroke();
    }

    // Baseline bars: link degree per note, in its project's colour.
    for (const n of ordered) {
      const x = xOf.get(n.id)!;
      const d = degree.get(n.id) ?? 0;
      const h = 6 + (d / maxDeg) * (barH - 10);
      const [r, g, b] = hexToRgb(n.color);
      ctx.fillStyle = `rgba(${r},${g},${b},${d ? 0.9 : 0.35})`;
      ctx.fillRect(x - Math.max(0.6, step * 0.35), baseY + 2, Math.max(1.2, step * 0.7), h);
    }

    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, baseY + 1.5);
    ctx.lineTo(W - padX, baseY + 1.5);
    ctx.stroke();
  }, [data, crossOnly, showInferred]);

  useEffect(() => {
    draw();
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  // Returns the note under the cursor plus its canvas-relative x, so the
  // tooltip can be positioned without reading a ref during render.
  const nodeAt = (clientX: number, clientY: number): { node: Node; x: number } | null => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (y < layout.baseY - 6) return null; // only the baseline strip is interactive
    let best: Node | null = null;
    let bestD = 8;
    for (const n of layout.ordered) {
      const d = Math.abs((layout.xOf.get(n.id) ?? -999) - x);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best ? { node: best, x } : null;
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
          onMouseMove={(e) => setHover(nodeAt(e.clientX, e.clientY))}
          onMouseLeave={() => setHover(null)}
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
        {hover && (
          <div className="arc-tip" style={{ left: Math.max(8, hover.x - 40), bottom: 8 }}>
            <span className="cdot" style={{ background: hover.node.color }} /> {hover.node.label}
          </div>
        )}
        <div className="graph-legend">
          <div className="graph-legend-title">Projects (left to right)</div>
          {data?.projects.map((p) => (
            <div key={p.id} className="graph-legend-item">
              <span className="cdot" style={{ background: p.color }} />
              <span className="truncate">{p.name}</span>
            </div>
          ))}
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
