"use client";

import { useEffect, useRef, useState } from "react";

type GNode = { id: string; label: string; color: string; projectId: string };
type GProject = { id: string; name: string; color: string };
type GraphData = { nodes: GNode[]; edges: { source: string; target: string }[]; projects: GProject[] };
type Sim = GNode & { x: number; y: number; vx: number; vy: number };

// "all" is the whole-vault view: every note across every project, colored by
// project, with links shown both within and across projects.
const SCOPES = [
  { key: "project", label: "This project" },
  { key: "connected", label: "Connected" },
  { key: "all", label: "Whole vault" },
];

// Eye (visible) / eye with a slash (hidden) for the per-project legend toggle.
function Eye({ off }: { off: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

export default function GraphView({
  projectId,
  scope,
  onOpen,
}: {
  projectId: string;
  scope: string; // initial scope; the graph then owns its own scope toggle
  onOpen: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gscope, setGscope] = useState(scope);
  // Fetched graph is keyed by its query, so switching project/scope shows the
  // loading state by derivation — no setState in the effect body needed.
  const fetchKey = `${projectId}|${gscope}`;
  const [fetched, setFetched] = useState<{ key: string; graph: GraphData } | null>(null);
  const data = fetched?.key === fetchKey ? fetched.graph : null;
  // Hidden projects (by id). Kept in a ref too so the animation loop reads the
  // latest set without restarting the simulation (toggling never reshuffles).
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const hiddenRef = useRef(hidden);
  useEffect(() => {
    hiddenRef.current = hidden;
  }, [hidden]);
  const onOpenRef = useRef(onOpen);
  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);
  // Lets outside events (a project toggle) re-energize and re-draw the frozen sim.
  const reheatRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/graph?projectId=${encodeURIComponent(projectId)}&scope=${gscope}`)
      .then((r) => r.json())
      .then((d: GraphData) => {
        if (cancelled) return;
        setFetched({ key: `${projectId}|${gscope}`, graph: d });
        setHidden(new Set());
      })
      .catch(() => !cancelled && setFetched({ key: `${projectId}|${gscope}`, graph: { nodes: [], edges: [], projects: [] } }));
    return () => {
      cancelled = true;
    };
  }, [projectId, gscope]);

  useEffect(() => {
    if (!data) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const size = () => canvas.getBoundingClientRect();
    const resize = () => {
      const r = size();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const w = size().width;
    const h = size().height;
    const nodes: Sim[] = data.nodes.map((n, i) => {
      const a = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
      return { ...n, x: w / 2 + Math.cos(a) * 130, y: h / 2 + Math.sin(a) * 130, vx: 0, vy: 0 };
    });
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    const edges = data.edges.filter((e) => index.has(e.source) && index.has(e.target));

    // Simulation energy: starts hot, cools each frame, freezes the loop when
    // settled (no perpetual motion / CPU burn), and is re-heated on interaction.
    let alpha = 1;
    let raf = 0;
    let running = false;
    const MAX_V = 30; // per-frame velocity cap — nothing can fling
    const MIN_DIST2 = 100; // floor on squared distance so close nodes can't explode
    const start = () => {
      if (!running) {
        running = true;
        raf = requestAnimationFrame(tick);
      }
    };
    const reheat = () => {
      alpha = Math.max(alpha, 0.5); // gentle resettle, not a violent reshuffle
      start();
    };
    reheatRef.current = reheat;

    let dragging: Sim | null = null;
    let moved = false;
    const at = (e: MouseEvent) => {
      const r = size();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pick = (x: number, y: number) =>
      nodes.find((n) => !hiddenRef.current.has(n.projectId) && (n.x - x) ** 2 + (n.y - y) ** 2 < 120);
    const down = (e: MouseEvent) => {
      const p = at(e);
      dragging = pick(p.x, p.y) ?? null;
      moved = false;
      if (dragging) reheat();
    };
    const move = (e: MouseEvent) => {
      if (!dragging) return;
      const p = at(e);
      dragging.x = p.x;
      dragging.y = p.y;
      dragging.vx = dragging.vy = 0;
      moved = true;
    };
    const up = () => {
      if (dragging && !moved) onOpenRef.current(dragging.id);
      dragging = null;
      reheat();
    };
    const onResize = () => {
      resize();
      reheat();
    };
    canvas.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("resize", onResize);

    const tick = () => {
      const W = size().width;
      const H = size().height;
      const cx = W / 2;
      const cy = H / 2;
      const hid = hiddenRef.current; // hidden projects skip forces, edges and drawing
      if (dragging) alpha = Math.max(alpha, 0.3); // keep neighbours responsive while dragging

      // Repulsion — inverse-square, but floored (no spike when nodes are close)
      // and scaled by alpha so it fades as the layout settles.
      for (let i = 0; i < nodes.length; i++) {
        if (hid.has(nodes[i].projectId)) continue;
        for (let j = i + 1; j < nodes.length; j++) {
          if (hid.has(nodes[j].projectId)) continue;
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = Math.max(dx * dx + dy * dy, MIN_DIST2);
          const d = Math.sqrt(d2);
          const f = (1500 / d2) * alpha; // max 15*alpha at the floor — can't explode
          const ux = dx / d;
          const uy = dy / d;
          a.vx += ux * f;
          a.vy += uy * f;
          b.vx -= ux * f;
          b.vy -= uy * f;
        }
      }
      // Springs toward 90px along edges.
      for (const e of edges) {
        const a = nodes[index.get(e.source)!];
        const b = nodes[index.get(e.target)!];
        if (hid.has(a.projectId) || hid.has(b.projectId)) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 90) * 0.02 * alpha;
        const ux = dx / d;
        const uy = dy / d;
        a.vx += ux * f;
        a.vy += uy * f;
        b.vx -= ux * f;
        b.vy -= uy * f;
      }
      // Weak centering + damping + velocity cap + integrate.
      for (const n of nodes) {
        if (n === dragging || hid.has(n.projectId)) continue;
        n.vx += (cx - n.x) * 0.0015 * alpha;
        n.vy += (cy - n.y) * 0.0015 * alpha;
        n.vx *= 0.85;
        n.vy *= 0.85;
        const sp = Math.hypot(n.vx, n.vy);
        if (sp > MAX_V) {
          const k = MAX_V / sp;
          n.vx *= k;
          n.vy *= k;
        }
        n.x += n.vx;
        n.y += n.vy;
      }

      alpha *= 0.96; // cool down — reaches the freeze threshold in ~1.5s

      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(10,10,10,0.18)";
      ctx.lineWidth = 1;
      for (const e of edges) {
        const a = nodes[index.get(e.source)!];
        const b = nodes[index.get(e.target)!];
        if (hid.has(a.projectId) || hid.has(b.projectId)) continue;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
      for (const n of nodes) {
        if (hid.has(n.projectId)) continue;
        ctx.beginPath();
        ctx.arc(n.x, n.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = n.color || "#8b7cf6";
        ctx.fill();
        ctx.fillStyle = "rgba(10,10,10,0.85)";
        ctx.fillText(n.label.length > 24 ? n.label.slice(0, 24) + "…" : n.label, n.x + 10, n.y + 4);
      }

      // Keep animating only while there's energy (or a drag); otherwise freeze.
      if (alpha > 0.02 || dragging) {
        raf = requestAnimationFrame(tick);
      } else {
        running = false;
      }
    };
    start();

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      reheatRef.current = null;
      canvas.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("resize", onResize);
    };
  }, [data]);

  // Toggling a project re-energizes the (possibly frozen) sim so it resettles + redraws.
  useEffect(() => {
    reheatRef.current?.();
  }, [hidden]);

  const projects = data?.projects ?? [];
  const empty = data !== null && data.nodes.length === 0;

  const toggle = (pid: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });

  return (
    <div className="graph-wrap">
      <div className="graph-controls">
        <div className="scope">
          {SCOPES.map((s) => (
            <button key={s.key} className={gscope === s.key ? "on" : ""} onClick={() => setGscope(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        {data && (
          <span className="graph-count">
            {data.nodes.length} {data.nodes.length === 1 ? "note" : "notes"} · {data.edges.length}{" "}
            {data.edges.length === 1 ? "link" : "links"}
            {projects.length > 1 ? ` · ${projects.length} projects` : ""}
          </span>
        )}
      </div>
      <div className="graph-stage">
        <canvas ref={canvasRef} className="graph-canvas" />
        {empty && (
          <div className="graph-empty">
            <p className="empty">
              No linked notes in this scope yet. Create notes and link them with [[wikilinks]], or switch scope above.
            </p>
          </div>
        )}
        {projects.length > 0 && (
          <div className="graph-legend">
            <div className="graph-legend-title">Projects</div>
            {projects.map((p) => {
              const off = hidden.has(p.id);
              return (
                <span key={p.id} className={`graph-legend-item${off ? " off" : ""}`}>
                  <button
                    className="graph-eye"
                    onClick={() => toggle(p.id)}
                    title={off ? `Show ${p.name}` : `Hide ${p.name}`}
                    aria-label={off ? `Show ${p.name}` : `Hide ${p.name}`}
                  >
                    <Eye off={off} />
                  </button>
                  <span className="cdot" style={{ background: p.color }} />
                  <span className="truncate">{p.name}</span>
                </span>
              );
            })}
            {projects.length > 1 && (
              <div className="graph-legend-actions">
                <button className="graph-legend-all" onClick={() => setHidden(new Set())}>
                  Show all
                </button>
                <button className="graph-legend-all" onClick={() => setHidden(new Set(projects.map((p) => p.id)))}>
                  Hide all
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
