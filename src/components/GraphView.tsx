"use client";

import { useEffect, useRef, useState } from "react";

type GNode = { id: string; label: string; color: string };
type GraphData = { nodes: GNode[]; edges: { source: string; target: string }[] };
type Sim = GNode & { x: number; y: number; vx: number; vy: number };

export default function GraphView({
  projectId,
  scope,
  onOpen,
}: {
  projectId: string;
  scope: string;
  onOpen: (id: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/graph?projectId=${encodeURIComponent(projectId)}&scope=${scope}`)
      .then((r) => r.json())
      .then((d: GraphData) => !cancelled && setData(d))
      .catch(() => !cancelled && setData({ nodes: [], edges: [] }));
    return () => {
      cancelled = true;
    };
  }, [projectId, scope]);

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

    let dragging: Sim | null = null;
    let moved = false;
    const at = (e: MouseEvent) => {
      const r = size();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const pick = (x: number, y: number) => nodes.find((n) => (n.x - x) ** 2 + (n.y - y) ** 2 < 120);
    const down = (e: MouseEvent) => {
      const p = at(e);
      dragging = pick(p.x, p.y) ?? null;
      moved = false;
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
    };
    canvas.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("resize", resize);

    let raf = 0;
    const tick = () => {
      const W = size().width;
      const H = size().height;
      const cx = W / 2;
      const cy = H / 2;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy || 0.01;
          const d = Math.sqrt(d2);
          const f = 1500 / d2;
          const ux = dx / d;
          const uy = dy / d;
          a.vx += ux * f;
          a.vy += uy * f;
          b.vx -= ux * f;
          b.vy -= uy * f;
        }
      }
      for (const e of edges) {
        const a = nodes[index.get(e.source)!];
        const b = nodes[index.get(e.target)!];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d - 90) * 0.02;
        const ux = dx / d;
        const uy = dy / d;
        a.vx += ux * f;
        a.vy += uy * f;
        b.vx -= ux * f;
        b.vy -= uy * f;
      }
      for (const n of nodes) {
        if (n === dragging) continue;
        n.vx += (cx - n.x) * 0.0015;
        n.vy += (cy - n.y) * 0.0015;
        n.vx *= 0.85;
        n.vy *= 0.85;
        n.x += n.vx;
        n.y += n.vy;
      }
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(255,255,255,0.09)";
      ctx.lineWidth = 1;
      for (const e of edges) {
        const a = nodes[index.get(e.source)!];
        const b = nodes[index.get(e.target)!];
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = n.color || "#8b7cf6";
        ctx.fill();
        ctx.fillStyle = "rgba(232,232,236,0.82)";
        ctx.fillText(n.label.length > 24 ? n.label.slice(0, 24) + "…" : n.label, n.x + 10, n.y + 4);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("resize", resize);
    };
  }, [data]);

  if (data && data.nodes.length === 0)
    return <p className="empty">No notes to graph yet. Create notes and link them with [[wikilinks]].</p>;
  return <canvas ref={canvasRef} className="graph-canvas" />;
}
