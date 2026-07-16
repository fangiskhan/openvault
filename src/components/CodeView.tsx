"use client";

import { useCallback, useEffect, useState } from "react";

type WorkItem = {
  intentId: string;
  actor: string;
  intent: string;
  paths: string[];
  status: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  updatedAt: string;
};
type CodeFileMeta = { path: string; hash: string; size: number; ref: string | null; syncedBy: string | null; updatedAt: string };
type CodeFileFull = CodeFileMeta & { content: string };

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

const STATUS_COLOR: Record<string, string> = {
  planning: "var(--cyan)",
  in_progress: "var(--lime)",
  in_review: "var(--magenta)",
  done: "var(--rag-green)",
};

// The Code tab: what the agents share, visible to humans — the work board
// (who is doing what, the review queue with approve/request-changes for
// owners/executives) and the synced code mirror.
export default function CodeView({ projectId, canReview, onError }: { projectId: string; canReview: boolean; onError: (msg: string) => void }) {
  const [work, setWork] = useState<{ active: WorkItem[]; recentlyDone: WorkItem[] } | null>(null);
  const [files, setFiles] = useState<CodeFileMeta[]>([]);
  // The open file is keyed to its project: switching projects derives back to
  // "nothing open" without a setState in the load effect.
  const [opened, setOpened] = useState<{ forProject: string; file: CodeFileFull } | null>(null);
  const file = opened?.forProject === projectId ? opened.file : null;
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [w, c] = await Promise.all([
        api(`/api/work?projectId=${projectId}`),
        api(`/api/code?projectId=${projectId}`),
      ]);
      setWork(w);
      setFiles(c.files);
    } catch {
      onError("Couldn't load the code board.");
    }
  }, [projectId, onError]);

  useEffect(() => {
    // Initial load, with all setState confined to promise callbacks.
    let live = true;
    Promise.all([api(`/api/work?projectId=${projectId}`), api(`/api/code?projectId=${projectId}`)])
      .then(([w, c]) => {
        if (!live) return;
        setWork(w);
        setFiles(c.files);
      })
      .catch(() => {
        if (live) onError("Couldn't load the code board.");
      });
    return () => {
      live = false;
    };
  }, [projectId, onError]);

  const openFile = async (path: string) => {
    try {
      const f = await api(`/api/code?projectId=${projectId}&path=${encodeURIComponent(path)}`);
      setOpened({ forProject: projectId, file: f });
    } catch {
      onError("Couldn't read that file from the mirror.");
    }
  };

  const review = async (intentId: string, verdict: "approve" | "request_changes") => {
    let note: string | undefined;
    if (verdict === "request_changes") {
      note = window.prompt("What should change? (sent back to the actor)") ?? undefined;
      if (!note?.trim()) return;
    }
    setBusy(intentId);
    try {
      await api(`/api/work/${intentId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict, note }),
      });
      await load();
    } catch {
      onError("Review failed — owner/executive access required.");
    } finally {
      setBusy(null);
    }
  };

  const board = (items: WorkItem[], empty: string) =>
    items.length === 0 ? (
      <p className="empty">{empty}</p>
    ) : (
      items.map((w) => (
        <div key={w.intentId} className="work-card">
          <span className="work-dot" style={{ background: STATUS_COLOR[w.status] ?? "var(--text-faint)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="work-head">
              <b>{w.actor}</b> · {w.status.replace("_", " ")}
              {w.reviewedBy && <span className="sub"> · approved by {w.reviewedBy}</span>}
            </div>
            <div className="work-intent">{w.intent}</div>
            {w.paths.length > 0 && (
              <div className="work-paths">
                {w.paths.map((p) => (
                  <button key={p} className="work-path" onClick={() => openFile(p)} title="Open in the mirror">
                    {p}
                  </button>
                ))}
              </div>
            )}
            {w.reviewNote && <div className="work-note">“{w.reviewNote}”</div>}
          </div>
          {canReview && w.status === "in_review" && (
            <span style={{ display: "flex", gap: 6, flex: "none" }}>
              <button className="btn" disabled={busy === w.intentId} onClick={() => review(w.intentId, "approve")}>
                Approve
              </button>
              <button className="btn" disabled={busy === w.intentId} onClick={() => review(w.intentId, "request_changes")}>
                Changes
              </button>
            </span>
          )}
        </div>
      ))
    );

  return (
    <div className="doc" style={{ maxWidth: 900 }}>
      <h1 className="code-h1">Active work</h1>
      <p className="empty" style={{ marginBottom: 12 }}>
        What every connected agent is doing right now. <b>in review</b> items await an owner/executive verdict —
        nothing lands in git unapproved.
      </p>
      {work && board(work.active, "No active work. Agents announce here before they edit.")}

      <h1 className="code-h1">Code mirror</h1>
      <p className="empty" style={{ marginBottom: 12 }}>
        The latest code agents synced ({files.length} file{files.length === 1 ? "" : "s"}) — browse without pulling git.
      </p>
      {files.length === 0 ? (
        <p className="empty">Nothing synced yet. Agents push files here with sync_code when they finish work.</p>
      ) : (
        <div className="code-grid">
          <div className="code-tree">
            {files.map((f) => (
              <button
                key={f.path}
                className={`rail-link${file?.path === f.path ? " active" : ""}`}
                onClick={() => openFile(f.path)}
              >
                {f.path}
                <span className="sub"> · {f.syncedBy ?? "?"}</span>
              </button>
            ))}
          </div>
          <div className="code-pane">
            {file ? (
              <>
                <div className="code-meta">
                  <code>{file.path}</code>
                  <span className="sub">
                    {file.ref ? `${file.ref} · ` : ""}synced by {file.syncedBy ?? "?"} ·{" "}
                    {new Date(file.updatedAt).toLocaleString()}
                  </span>
                </div>
                <pre className="code-body">{file.content}</pre>
              </>
            ) : (
              <p className="empty" style={{ padding: 16 }}>Select a file to read it.</p>
            )}
          </div>
        </div>
      )}

      {work && work.recentlyDone.length > 0 && (
        <>
          <h1 className="code-h1">Recently approved</h1>
          {board(work.recentlyDone, "")}
        </>
      )}
    </div>
  );
}
