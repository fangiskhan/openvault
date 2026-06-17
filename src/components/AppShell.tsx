"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import SpreadsheetView, { type Sheet } from "./SpreadsheetView";
import GraphView from "./GraphView";
import StatusView from "./StatusView";

type Project = { id: string; name: string; color: string | null; itemCount: number };
type Connection = { id: string; name: string; color: string | null; slug: string; kind: string };
type ItemRef = { id: string; title: string; type: string; updatedAt: string };
type Detail = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  items: ItemRef[];
  connections: Connection[];
};
type LinkRef = { targetTitle: string; toItem: { id: string; title: string; projectId: string } | null };
type Backlink = { id: string; title: string; projectId: string; projectName: string; projectColor: string | null };
type ItemFull = {
  id: string;
  projectId: string;
  project: { id: string; name: string; color: string | null };
  type: string;
  source: string;
  status: string | null;
  dueAt: string | null;
  closedAt: string | null;
  title: string;
  body: string;
  metadata: { sheets?: Sheet[] } | null;
  updatedAt: string;
  links: LinkRef[];
  backlinks: Backlink[];
};
type SearchResult = {
  id: string;
  title: string;
  type: string;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  snippet: string;
};

const SCOPES = [
  { key: "project", label: "This project" },
  { key: "connected", label: "Connected" },
  { key: "all", label: "All" },
];

const mini = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 12,
  padding: "2px 6px",
};

function iconFor(type: string) {
  if (type === "spreadsheet") return "▦";
  if (type === "meeting") return "◷";
  if (type === "task") return "☑";
  if (type === "risk") return "▲";
  if (type === "file") return "⎙";
  if (type === "message") return "💬";
  return "§";
}

async function api(path: string, opts?: RequestInit) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

export default function AppShell() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [item, setItem] = useState<ItemFull | null>(null);
  const [title, setTitle] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [save, setSave] = useState<"idle" | "saving" | "saved">("idle");
  const [scope, setScope] = useState("project");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [view, setView] = useState<"notes" | "status">("notes");

  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadProjects = useCallback(async () => {
    const ps: Project[] = await api("/api/projects");
    setProjects(ps);
    return ps;
  }, []);

  const loadDetail = useCallback(async (projectId: string) => {
    const d: Detail = await api(`/api/projects/${projectId}`);
    setDetail(d);
    return d;
  }, []);

  const openItem = useCallback(
    async (id: string) => {
      const it: ItemFull = await api(`/api/items/${id}`);
      dirty.current = false;
      setItem(it);
      setTitle(it.title);
      setBodyDraft(it.body);
      setMode("read");
      setSave("idle");
      setView("notes");
      setActiveProjectId((cur) => {
        if (it.projectId !== cur) loadDetail(it.projectId);
        return it.projectId;
      });
    },
    [loadDetail],
  );

  const selectProject = useCallback(
    async (id: string) => {
      setActiveProjectId(id);
      setItem(null);
      const d = await loadDetail(id);
      if (d.items.length) openItem(d.items[0].id);
    },
    [loadDetail, openItem],
  );

  useEffect(() => {
    (async () => {
      const ps = await loadProjects();
      if (ps.length) {
        setActiveProjectId(ps[0].id);
        const d = await loadDetail(ps[0].id);
        if (d.items.length) openItem(d.items[0].id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave (debounced) when the open note is edited.
  useEffect(() => {
    if (!item || !dirty.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSave("saving");
    saveTimer.current = setTimeout(async () => {
      try {
        const updated = await api(`/api/items/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, body: bodyDraft }),
        });
        dirty.current = false;
        setSave("saved");
        const fresh: ItemFull = await api(`/api/items/${item.id}`);
        setItem(fresh);
        setDetail((d) =>
          d ? { ...d, items: d.items.map((x) => (x.id === item.id ? { ...x, title: updated.title } : x)) } : d,
        );
      } catch {
        setSave("idle");
      }
    }, 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, bodyDraft]);

  // Search (debounced).
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim()) {
      setResults(null);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      const params = new URLSearchParams({ q: query, scope });
      if (activeProjectId) params.set("projectId", activeProjectId);
      try {
        const r = await api(`/api/search?${params.toString()}`);
        setResults(r.results);
      } catch {
        setResults([]);
      }
    }, 200);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, scope, activeProjectId]);

  // ⌘K / Ctrl+K focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onTitle = (v: string) => {
    dirty.current = true;
    setTitle(v);
  };
  const onBody = (v: string) => {
    dirty.current = true;
    setBodyDraft(v);
  };

  // Status / due / type changes (no debounce — explicit control changes).
  const patchItem = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!item) return;
      await api(`/api/items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const fresh: ItemFull = await api(`/api/items/${item.id}`);
      setItem(fresh);
      setTitle(fresh.title);
      await loadDetail(item.projectId);
    },
    [item, loadDetail],
  );

  const newNote = useCallback(async () => {
    if (!activeProjectId) return;
    const created = await api("/api/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: activeProjectId, title: "Untitled", body: "" }),
    });
    await loadDetail(activeProjectId);
    await openItem(created.id);
    setMode("edit");
  }, [activeProjectId, loadDetail, openItem]);

  const newProject = useCallback(async () => {
    const name = window.prompt("Project name");
    if (!name) return;
    const p = await api("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await loadProjects();
    await selectProject(p.id);
  }, [loadProjects, selectProject]);

  const deleteItem = useCallback(async () => {
    if (!item) return;
    if (!window.confirm(`Delete “${item.title}”?`)) return;
    const pid = item.projectId;
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    setItem(null);
    const d = await loadDetail(pid);
    if (d.items.length) openItem(d.items[0].id);
  }, [item, loadDetail, openItem]);

  const openByTitle = useCallback(
    async (t: string) => {
      const tl = t.toLowerCase();
      const link = item?.links.find((l) => l.targetTitle.toLowerCase() === tl);
      if (link?.toItem) return openItem(link.toItem.id);
      const match = detail?.items.find((x) => x.title.toLowerCase() === tl);
      if (match) return openItem(match.id);
      if (!activeProjectId) return;
      const created = await api("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: activeProjectId, title: t, body: "" }),
      });
      await loadDetail(activeProjectId);
      await openItem(created.id);
      setMode("edit");
    },
    [item, detail, activeProjectId, loadDetail, openItem],
  );

  const resolve = useCallback(
    (t: string) => {
      const tl = t.toLowerCase();
      if (item?.links.some((l) => l.targetTitle.toLowerCase() === tl && l.toItem)) return true;
      return Boolean(detail?.items.some((x) => x.title.toLowerCase() === tl));
    },
    [item, detail],
  );

  const connect = useCallback(
    async (toId: string) => {
      if (!activeProjectId) return;
      await api(`/api/projects/${activeProjectId}/connections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toProjectId: toId }),
      });
      await loadDetail(activeProjectId);
    },
    [activeProjectId, loadDetail],
  );

  const disconnect = useCallback(
    async (toId: string) => {
      if (!activeProjectId) return;
      await api(`/api/projects/${activeProjectId}/connections?to=${toId}`, { method: "DELETE" });
      await loadDetail(activeProjectId);
    },
    [activeProjectId, loadDetail],
  );

  const onUpload = useCallback(
    async (file: File) => {
      if (!activeProjectId) return;
      const fd = new FormData();
      fd.set("file", file);
      fd.set("projectId", activeProjectId);
      const created = await api("/api/upload", { method: "POST", body: fd });
      await loadDetail(activeProjectId);
      await openItem(created.id);
    },
    [activeProjectId, loadDetail, openItem],
  );

  const connectable = projects.filter(
    (p) => p.id !== activeProjectId && !detail?.connections.some((c) => c.id === p.id),
  );

  const statusOptions = item?.type === "task" ? ["open", "blocked", "done"] : ["open", "mitigating", "accepted", "closed"];

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="dot" /> OpenVault
        </div>
        <div className="scope">
          <button className={view === "notes" ? "on" : ""} onClick={() => setView("notes")}>
            Notes
          </button>
          <button className={view === "status" ? "on" : ""} onClick={() => setView("status")}>
            Status
          </button>
        </div>
        <div className="searchwrap">
          <input
            ref={searchRef}
            className="input"
            placeholder="Search…  (⌘K)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {results && (
            <div className="search-results">
              {results.length === 0 ? (
                <div className="search-result">
                  <span className="empty">No matches</span>
                </div>
              ) : (
                results.map((r) => (
                  <div
                    key={r.id}
                    className="search-result"
                    onClick={() => {
                      setQuery("");
                      setResults(null);
                      openItem(r.id);
                    }}
                  >
                    <div className="t">
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: r.projectColor ?? "#8b7cf6",
                          display: "inline-block",
                        }}
                      />
                      {r.title}
                      <span className="chip">{r.projectName}</span>
                    </div>
                    <div className="s">{r.snippet}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <div className="scope">
          {SCOPES.map((s) => (
            <button key={s.key} className={scope === s.key ? "on" : ""} onClick={() => setScope(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={!activeProjectId}>
          ↑ Upload
        </button>
        <button className="btn" onClick={() => setShowGraph(true)} disabled={!activeProjectId}>
          Graph
        </button>
        <button className="btn btn-accent" onClick={newNote} disabled={!activeProjectId}>
          + New note
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept=".xlsx,.xlsm,.csv,.md,.txt,.pdf"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUpload(f);
            e.target.value = "";
          }}
        />
      </div>

      <div className="workspace">
        <aside className="sidebar">
          <div className="section-label">
            Projects
            <button className="btn-ghost" style={{ padding: "0 6px" }} onClick={newProject}>
              +
            </button>
          </div>
          {projects.map((p) => (
            <button
              key={p.id}
              className={`list-item${p.id === activeProjectId ? " active" : ""}`}
              onClick={() => selectProject(p.id)}
            >
              <span className="cdot" style={{ background: p.color ?? "#8b7cf6" }} />
              <span className="truncate">{p.name}</span>
              <span className="count">{p.itemCount}</span>
            </button>
          ))}

          {detail && (
            <>
              <div className="section-label">Notes</div>
              {detail.items.length === 0 && (
                <p className="empty" style={{ padding: "4px 8px" }}>
                  No notes yet.
                </p>
              )}
              {detail.items.map((it) => (
                <button
                  key={it.id}
                  className={`list-item${it.id === item?.id ? " active" : ""}`}
                  onClick={() => openItem(it.id)}
                >
                  <span style={{ opacity: 0.6, fontSize: 12, width: 14, textAlign: "center" }}>
                    {iconFor(it.type)}
                  </span>
                  <span className="truncate">{it.title}</span>
                </button>
              ))}

              <div className="section-label">
                Connections
                <button className="btn-ghost" style={{ padding: "0 6px" }} onClick={() => setShowConnect(true)}>
                  +
                </button>
              </div>
              {detail.connections.length === 0 && (
                <p className="empty" style={{ padding: "4px 8px" }}>
                  None. Connect related projects to share links and search.
                </p>
              )}
              {detail.connections.map((c) => (
                <button key={c.id} className="list-item" onClick={() => selectProject(c.id)}>
                  <span className="cdot" style={{ background: c.color ?? "#8b7cf6" }} />
                  <span className="truncate">{c.name}</span>
                  <span
                    className="count"
                    title="Disconnect"
                    onClick={(e) => {
                      e.stopPropagation();
                      disconnect(c.id);
                    }}
                  >
                    ✕
                  </span>
                </button>
              ))}
            </>
          )}
        </aside>

        <main className="main">
          {view === "status" && activeProjectId ? (
            <StatusView
              projectId={activeProjectId}
              scope={scope}
              onOpen={(id) => {
                setView("notes");
                openItem(id);
              }}
            />
          ) : item ? (
            <div className="doc">
              <input
                className="title-input"
                value={title}
                onChange={(e) => onTitle(e.target.value)}
                placeholder="Untitled"
              />
              <div className="meta-row">
                <span>{item.project.name}</span>
                <span>·</span>
                <select value={item.type} onChange={(e) => patchItem({ type: e.target.value })} style={mini}>
                  {["note", "task", "risk", "meeting"].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {(item.type === "task" || item.type === "risk") && (
                  <select
                    value={item.status ?? ""}
                    onChange={(e) => patchItem({ status: e.target.value || null })}
                    style={mini}
                  >
                    <option value="">— status —</option>
                    {statusOptions.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                )}
                {item.type === "task" && (
                  <input
                    type="date"
                    value={item.dueAt ? item.dueAt.slice(0, 10) : ""}
                    onChange={(e) =>
                      patchItem({ dueAt: e.target.value ? new Date(e.target.value).toISOString() : null })
                    }
                    style={mini}
                  />
                )}
                {save !== "idle" && (
                  <>
                    <span>·</span>
                    <span>{save === "saving" ? "Saving…" : "Saved"}</span>
                  </>
                )}
                <div className="spacer" />
                {item.type !== "spreadsheet" && (
                  <div className="scope">
                    <button className={mode === "read" ? "on" : ""} onClick={() => setMode("read")}>
                      Read
                    </button>
                    <button className={mode === "edit" ? "on" : ""} onClick={() => setMode("edit")}>
                      Edit
                    </button>
                  </div>
                )}
                <button className="btn-ghost" onClick={deleteItem} title="Delete">
                  🗑
                </button>
              </div>

              {item.type === "spreadsheet" && item.metadata?.sheets ? (
                <SpreadsheetView sheets={item.metadata.sheets} />
              ) : mode === "edit" ? (
                <textarea
                  className="editor"
                  value={bodyDraft}
                  onChange={(e) => onBody(e.target.value)}
                  placeholder="Write in markdown. Link notes with [[double brackets]]."
                  autoFocus
                />
              ) : bodyDraft.trim() ? (
                <Markdown body={bodyDraft} resolve={resolve} onWikilink={openByTitle} />
              ) : (
                <p className="empty">Empty note. Switch to Edit to start writing.</p>
              )}
            </div>
          ) : (
            <div className="doc">
              <p className="empty">{activeProjectId ? "Select or create a note." : "Create a project to begin."}</p>
            </div>
          )}
        </main>

        <aside className="rail">
          {view === "notes" && item && (
            <>
              <div className="rail-section">
                <h4>Links</h4>
                {item.links.length === 0 ? (
                  <p className="empty">No outgoing links.</p>
                ) : (
                  item.links.map((l, i) => (
                    <button key={i} className="rail-link" onClick={() => openByTitle(l.targetTitle)}>
                      {l.targetTitle}
                      {!l.toItem && <span className="sub"> · new</span>}
                    </button>
                  ))
                )}
              </div>
              <div className="rail-section">
                <h4>Backlinks</h4>
                {item.backlinks.length === 0 ? (
                  <p className="empty">Nothing links here yet.</p>
                ) : (
                  item.backlinks.map((b) => (
                    <button key={b.id} className="rail-link" onClick={() => openItem(b.id)}>
                      {b.title}
                      {b.projectId !== item.projectId && <span className="sub"> · {b.projectName}</span>}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </aside>
      </div>

      {showGraph && activeProjectId && (
        <div className="overlay" onClick={() => setShowGraph(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>
                Graph — {scope === "all" ? "all projects" : scope === "connected" ? "connected projects" : detail?.name}
              </span>
              <button className="btn-ghost" onClick={() => setShowGraph(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <GraphView
                projectId={activeProjectId}
                scope={scope}
                onOpen={(id) => {
                  setShowGraph(false);
                  openItem(id);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {showConnect && (
        <div className="overlay" onClick={() => setShowConnect(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Connect a project</span>
              <button className="btn-ghost" onClick={() => setShowConnect(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p className="empty" style={{ marginBottom: 12 }}>
                Connected projects share wikilinks and appear under the “Connected” search scope.
              </p>
              {connectable.length === 0 ? (
                <p className="empty">No other projects to connect.</p>
              ) : (
                connectable.map((p) => (
                  <button
                    key={p.id}
                    className="list-item"
                    onClick={() => {
                      connect(p.id);
                      setShowConnect(false);
                    }}
                  >
                    <span className="cdot" style={{ background: p.color ?? "#8b7cf6" }} />
                    <span className="truncate">{p.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
