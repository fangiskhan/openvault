"use client";

import { useEffect, useState } from "react";

type Rag = "green" | "amber" | "red";
type Signal = {
  itemId: string;
  projectName: string;
  title: string;
  label: "Critical" | "High" | "Watch";
  reason: string;
};
type ProjectRollup = {
  projectId: string;
  projectName: string;
  computed: Rag;
  manual: string | null;
  diverges: boolean;
  signalCount: number;
};
type StatusResp = { headline: Rag; projects: ProjectRollup[] };
type Briefing = {
  headline: { rag: Rag; text: string };
  recentDecisions: { itemId: string; title: string; projectName: string }[];
  recentlyUpdated: { itemId: string; title: string; projectName: string; updatedAt: string }[];
  coverage: { itemsConsidered: number; projects: number; windowDays: number };
};

const RAG: Record<Rag, string> = { green: "var(--rag-green)", amber: "var(--rag-amber)", red: "var(--rag-red)" };
const DOT = (c: string) => ({ width: 9, height: 9, borderRadius: "50%", background: c, flex: "none" as const });

export default function StatusView({
  projectId,
  scope,
  onOpen,
}: {
  projectId: string;
  scope: string;
  onOpen: (id: string) => void;
}) {
  // The payload is keyed by its query: switching project/scope derives back to
  // "loading" without any setState in the effect body.
  const key = `${projectId}|${scope}`;
  const [payload, setPayload] = useState<{
    key: string;
    status: StatusResp | null;
    signals: Signal[] | null;
    briefing: Briefing | null;
  } | null>(null);
  const fresh = payload?.key === key ? payload : null;
  const loading = !fresh;
  const status = fresh?.status ?? null;
  const signals = fresh?.signals ?? null;
  const briefing = fresh?.briefing ?? null;

  useEffect(() => {
    let cancel = false;
    const qs = `projectId=${encodeURIComponent(projectId)}&scope=${scope}`;
    const k = `${projectId}|${scope}`;
    Promise.all([
      fetch(`/api/status?${qs}`).then((r) => r.json()),
      fetch(`/api/attention?${qs}`).then((r) => r.json()),
      fetch(`/api/briefings?${qs}`).then((r) => r.json()),
    ])
      .then(([s, a, b]) => {
        if (cancel) return;
        setPayload({ key: k, status: s, signals: a.signals ?? [], briefing: b });
      })
      .catch(() => !cancel && setPayload({ key: k, status: null, signals: [], briefing: null }));
    return () => {
      cancel = true;
    };
  }, [projectId, scope]);

  if (loading)
    return (
      <div className="doc">
        <p className="empty">Computing status…</p>
      </div>
    );

  const headline = status?.headline ?? "green";

  return (
    <div className="doc">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
        <span style={{ width: 14, height: 14, borderRadius: "50%", background: RAG[headline] }} />
        <h1 style={{ margin: 0, fontSize: 24, letterSpacing: "-0.02em" }}>{briefing?.headline.text ?? "Status"}</h1>
      </div>
      <div className="meta-row">
        <span>Scope: {scope}</span>
        {briefing && (
          <>
            <span>·</span>
            <span>
              {briefing.coverage.itemsConsidered} items · {briefing.coverage.projects} project(s) ·{" "}
              {briefing.coverage.windowDays}d window
            </span>
          </>
        )}
        <span>·</span>
        <span>templated · 0 tokens</span>
      </div>

      {status && status.projects.length > 0 && (
        <div className="rail-section">
          <h4>Project health</h4>
          {status.projects.map((p) => (
            <div key={p.projectId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}>
              <span style={DOT(RAG[p.computed])} />
              <span>{p.projectName}</span>
              {p.manual && <span className="chip">manual: {p.manual}</span>}
              {p.diverges && (
                <span className="chip" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                  diverges
                </span>
              )}
              <span className="count" style={{ marginLeft: "auto" }}>
                {p.signalCount} signal(s)
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="rail-section">
        <h4>Areas needing attention</h4>
        {signals && signals.length === 0 && (
          <p className="empty">No blockers surfaced from the last 14 days. ✓</p>
        )}
        {signals?.map((s, i) => (
          <button
            key={i}
            className="rail-link"
            style={{ display: "flex", alignItems: "center", gap: 10 }}
            onClick={() => onOpen(s.itemId)}
          >
            <span
              style={DOT(s.label === "Critical" ? "var(--danger)" : s.label === "High" ? "var(--rag-amber)" : "var(--text-faint)")}
            />
            <span style={{ flex: 1 }}>
              {s.title} <span className="sub">— {s.reason}</span>
            </span>
            <span className="chip">{s.label}</span>
            {scope !== "project" && <span className="chip">{s.projectName}</span>}
          </button>
        ))}
      </div>

      {briefing && briefing.recentDecisions.length > 0 && (
        <div className="rail-section">
          <h4>Recent decisions</h4>
          {briefing.recentDecisions.map((d) => (
            <button key={d.itemId} className="rail-link" onClick={() => onOpen(d.itemId)}>
              {d.title} <span className="sub">· {d.projectName}</span>
            </button>
          ))}
        </div>
      )}

      {briefing && (
        <div className="rail-section">
          <h4>Recently updated</h4>
          {briefing.recentlyUpdated.length === 0 && <p className="empty">Nothing updated in the window.</p>}
          {briefing.recentlyUpdated.map((r) => (
            <button key={r.itemId} className="rail-link" onClick={() => onOpen(r.itemId)}>
              {r.title} <span className="sub">· {r.projectName} · {r.updatedAt.slice(0, 10)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
