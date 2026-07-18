"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import SpreadsheetView, { type Sheet } from "./SpreadsheetView";
import GraphView from "./GraphView";
import StatusView from "./StatusView";
import AccountsAdmin from "./AccountsAdmin";
import CodeView from "./CodeView";

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
type RelatedNote = { itemId: string; title: string; project: string; score: number; because: string[] };
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
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [toast, setToast] = useState<string | null>(null);
  const [scope, setScope] = useState("project");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [showGraph, setShowGraph] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);
  const [view, setView] = useState<"notes" | "status" | "code">("notes");
  // Inferred connections for the open note — notes that belong together but
  // were never wikilinked. Suggestions are keyed to the note they were fetched
  // for, so switching notes derives back to empty without effect-body setState.
  const [related, setRelated] = useState<{ forItem: string; suggestions: RelatedNote[] } | null>(null);
  const relatedNotes = item && related?.forItem === item.id ? related.suggestions : [];
  useEffect(() => {
    if (!item) return;
    let live = true;
    const id = item.id;
    const t = setTimeout(async () => {
      try {
        const r = await api(`/api/related?itemId=${id}`);
        if (live) setRelated({ forItem: id, suggestions: r.suggestions ?? [] });
      } catch {
        if (live) setRelated({ forItem: id, suggestions: [] });
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [item]);
  // Signed-in identity — drives the identity chip and whether review buttons show.
  const [me, setMe] = useState<{ kind: string; username?: string; role?: string } | null>(null);
  useEffect(() => {
    fetch("/api/auth")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  const [showConnectAgent, setShowConnectAgent] = useState(false);
  // Lazy init instead of an effect: only read inside the connect modal, which
  // opens post-hydration, so the SSR fallback never reaches the DOM.
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [copied, setCopied] = useState<string | null>(null);

  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Latest editable state, mirrored into a ref so flushSave can read it without
  // a stale closure when the user switches notes mid-edit.
  const latest = useRef({ item, title, bodyDraft });
  useEffect(() => {
    latest.current = { item, title, bodyDraft };
  }, [item, title, bodyDraft]);

  // Surface failures instead of swallowing them — a failed mutation must never
  // look identical to success in a source-of-truth tool.
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* clipboard blocked — no-op */
    }
  }, []);

  // Persist a pending edit immediately (used before navigating away from a note),
  // so the 700ms autosave debounce can never drop the last keystrokes.
  const flushSave = useCallback(async () => {
    if (!dirty.current) return;
    const { item: it, title: t, bodyDraft: b } = latest.current;
    if (!it) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    dirty.current = false;
    try {
      await api(`/api/items/${it.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t, body: b }),
      });
      setSave("saved");
    } catch {
      dirty.current = true; // still unsaved — keep the edit and let the user retry
      setSave("error");
    }
  }, []);

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
      await flushSave();
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
    [loadDetail, flushSave],
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
        setSave("error"); // dirty stays true — "Unsaved" indicator offers retry
      }
    }, 700);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, bodyDraft]);

  // Search (debounced). Clearing on empty input happens in the onChange
  // handler, so this effect only ever schedules the fetch callback.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim()) return;
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
      try {
        await api(`/api/items/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const fresh: ItemFull = await api(`/api/items/${item.id}`);
        setItem(fresh);
        setTitle(fresh.title);
        await loadDetail(item.projectId);
      } catch {
        notify("Couldn't update the note — change not saved.");
      }
    },
    [item, loadDetail, notify],
  );

  const newNote = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      const created = await api("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: activeProjectId, title: "Untitled", body: "" }),
      });
      await loadDetail(activeProjectId);
      await openItem(created.id);
      setMode("edit");
    } catch {
      notify("Couldn't create the note.");
    }
  }, [activeProjectId, loadDetail, openItem, notify]);

  const newProject = useCallback(async () => {
    const name = window.prompt("Project name");
    if (!name) return;
    try {
      const p = await api("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await loadProjects();
      await selectProject(p.id);
    } catch {
      notify("Couldn't create the project — the name may already be taken.");
    }
  }, [loadProjects, selectProject, notify]);

  const loadDemo = useCallback(async () => {
    try {
      await api("/api/demo", { method: "POST" });
      const ps = await loadProjects();
      if (ps.length) await selectProject(ps[0].id);
    } catch {
      notify("Couldn't load demo data — it only loads into an empty vault.");
    }
  }, [loadProjects, selectProject, notify]);

  const renameProject = useCallback(async () => {
    if (!activeProjectId || !detail) return;
    const name = window.prompt("Rename project", detail.name);
    if (!name || name === detail.name) return;
    try {
      await api(`/api/projects/${activeProjectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await loadProjects();
      await loadDetail(activeProjectId);
    } catch {
      notify("Couldn't rename the project.");
    }
  }, [activeProjectId, detail, loadProjects, loadDetail, notify]);

  const deleteProject = useCallback(async () => {
    if (!activeProjectId || !detail) return;
    if (!window.confirm(`Delete project “${detail.name}” and ALL its notes? This cannot be undone.`)) return;
    try {
      await api(`/api/projects/${activeProjectId}`, { method: "DELETE" });
      setItem(null);
      setDetail(null);
      setActiveProjectId(null);
      const ps = await loadProjects();
      if (ps.length) await selectProject(ps[0].id);
    } catch {
      notify("Couldn't delete the project.");
    }
  }, [activeProjectId, detail, loadProjects, selectProject, notify]);

  const deleteItem = useCallback(async () => {
    if (!item) return;
    if (!window.confirm(`Delete “${item.title}”?`)) return;
    dirty.current = false; // discarding — don't let a pending flush revive it
    const pid = item.projectId;
    try {
      await api(`/api/items/${item.id}`, { method: "DELETE" });
      setItem(null);
      const d = await loadDetail(pid);
      if (d.items.length) openItem(d.items[0].id);
    } catch {
      notify("Couldn't delete the note.");
    }
  }, [item, loadDetail, openItem, notify]);

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
      try {
        await api(`/api/projects/${activeProjectId}/connections`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toProjectId: toId }),
        });
        await loadDetail(activeProjectId);
      } catch {
        notify("Couldn't connect the projects.");
      }
    },
    [activeProjectId, loadDetail, notify],
  );

  const disconnect = useCallback(
    async (toId: string) => {
      if (!activeProjectId) return;
      try {
        await api(`/api/projects/${activeProjectId}/connections?to=${toId}`, { method: "DELETE" });
        await loadDetail(activeProjectId);
      } catch {
        notify("Couldn't disconnect the projects.");
      }
    },
    [activeProjectId, loadDetail, notify],
  );

  const onUpload = useCallback(
    async (file: File) => {
      if (!activeProjectId) return;
      try {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("projectId", activeProjectId);
        const created = await api("/api/upload", { method: "POST", body: fd });
        await loadDetail(activeProjectId);
        await openItem(created.id);
      } catch {
        notify("Upload failed — files must be under 25 MB.");
      }
    },
    [activeProjectId, loadDetail, openItem, notify],
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
          <button className={view === "code" ? "on" : ""} onClick={() => setView("code")}>
            Code
          </button>
        </div>
        <div className="searchwrap">
          <input
            ref={searchRef}
            className="input"
            placeholder="Search…  (⌘K)"
            value={query}
            onChange={(e) => {
              const v = e.target.value;
              setQuery(v);
              if (!v.trim()) setResults(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                setResults(null);
                searchRef.current?.blur();
              } else if (e.key === "Enter" && results?.length) {
                const first = results[0];
                setQuery("");
                setResults(null);
                openItem(first.id);
              }
            }}
            onBlur={() => {
              // Let a click on a result land before the dropdown unmounts.
              setTimeout(() => setResults(null), 150);
            }}
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
        {me?.username && me.kind !== "open" && (
          <button
            className="id-chip"
            title="Signed in — click to sign out"
            onClick={async () => {
              await fetch("/api/auth", { method: "DELETE" });
              window.location.href = "/login";
            }}
          >
            @{me.username}
            {me.role && me.role !== "member" ? ` · ${me.role}` : ""}
          </button>
        )}
        <button className="btn" onClick={() => fileRef.current?.click()} disabled={!activeProjectId}>
          ↑ Upload
        </button>
        <button className="btn" onClick={() => setShowGraph(true)} disabled={!activeProjectId}>
          Graph
        </button>
        <button className="btn" onClick={() => setShowAccounts(true)}>
          Accounts
        </button>
        <button className="btn" onClick={() => setShowConnectAgent(true)} title="Connect Claude Code / Cursor / Codex">
          Connect agent
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
            <span>
              <a className="btn-ghost" style={{ padding: "0 6px", textDecoration: "none" }} href="/api/export" title="Export whole vault (JSON)">
                ⤓
              </a>
              <button className="btn-ghost" style={{ padding: "0 6px" }} onClick={newProject}>
                +
              </button>
            </span>
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
              <div className="section-label">
                Notes
                <span title={`Manage “${detail.name}”`}>
                  <button className="btn-ghost" style={{ padding: "0 5px" }} onClick={renameProject} title="Rename project">
                    ✎
                  </button>
                  <a
                    className="btn-ghost"
                    style={{ padding: "0 5px", textDecoration: "none" }}
                    href={`/api/export?projectId=${detail.id}`}
                    title="Export this project (JSON)"
                  >
                    ⤓
                  </a>
                  <button className="btn-ghost" style={{ padding: "0 5px" }} onClick={deleteProject} title="Delete project">
                    ✕
                  </button>
                </span>
              </div>
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
          {view === "code" && activeProjectId ? (
            <CodeView
              projectId={activeProjectId}
              canReview={me?.role === "owner" || me?.role === "executive"}
              onError={notify}
            />
          ) : view === "status" && activeProjectId ? (
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
                    {save === "error" ? (
                      <button className="save-retry" onClick={flushSave} title="Save failed — click to retry">
                        Unsaved — retry
                      </button>
                    ) : (
                      <span>{save === "saving" ? "Saving…" : "Saved"}</span>
                    )}
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
          ) : projects.length === 0 ? (
            <div className="doc onboarding">
              <h1>Welcome to OpenVault</h1>
              <p className="lede">
                A self-hosted, project-centric knowledge hub your team <em>and</em> its AI agents share over MCP —
                notes, meetings, tasks, risks, and status in one grounded source of truth.
              </p>
              <div className="onboarding-actions">
                <button className="btn btn-accent" onClick={newProject}>
                  + Create your first project
                </button>
                <button className="btn" onClick={loadDemo}>
                  Load demo data
                </button>
                <button className="btn" onClick={() => setShowConnectAgent(true)}>
                  Connect an agent
                </button>
              </div>
              <p className="empty" style={{ marginTop: 16 }}>
                New here? “Load demo data” populates three linked projects with a live status board so you can see it
                working, then delete it anytime.
              </p>
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
              {relatedNotes.length > 0 && (
                <div className="rail-section">
                  <h4>Related (inferred)</h4>
                  {relatedNotes.map((r) => (
                    <button
                      key={r.itemId}
                      className="rail-link"
                      title={`shares: ${r.because.join(", ")}`}
                      onClick={() => openItem(r.itemId)}
                    >
                      {r.title}
                      <span className="sub"> · {r.because.slice(0, 2).join(", ")}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      {showGraph && activeProjectId && (
        <div className="overlay" onClick={() => setShowGraph(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Graph</span>
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

      {showAccounts && (
        <div className="overlay" onClick={() => setShowAccounts(false)}>
          <div className="spx" onClick={(e) => e.stopPropagation()}>
            <AccountsAdmin />
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}

      {showConnectAgent && (
        <div className="overlay" onClick={() => setShowConnectAgent(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Connect an agent</span>
              <button className="btn-ghost" onClick={() => setShowConnectAgent(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <p className="empty" style={{ marginBottom: 12 }}>
                Point Claude Code, Cursor, Codex, or any MCP client at this vault. It reads and writes shared project
                state so agents stay coordinated — no human handover.
              </p>

              <h4 className="rail-h">1 · Add the MCP server</h4>
              {(() => {
                const url = (origin || "http://localhost:6900") + "/api/mcp";
                const cmd = `claude mcp add openvault ${url} --transport http --scope user`;
                return (
                  <div className="copyrow">
                    <code className="codeblock">{cmd}</code>
                    <button className="btn" onClick={() => copy(cmd, "cmd")}>
                      {copied === "cmd" ? "Copied" : "Copy"}
                    </button>
                  </div>
                );
              })()}
              <p className="empty" style={{ margin: "6px 0 14px" }}>
                In production, add your account token:{" "}
                <code>--header &quot;Authorization: Bearer ovk_…&quot;</code> — create one under <strong>Accounts</strong>.
              </p>

              <h4 className="rail-h">2 · Project IDs</h4>
              <p className="empty" style={{ marginBottom: 8 }}>
                Agent tools and the <code>/vault</code> skill take a <code>projectId</code>. Copy one:
              </p>
              {projects.length === 0 ? (
                <p className="empty">No projects yet — create one first.</p>
              ) : (
                projects.map((p) => (
                  <div key={p.id} className="copyrow">
                    <span className="cdot" style={{ background: p.color ?? "#8b7cf6" }} />
                    <span className="truncate" style={{ flex: 1 }}>
                      {p.name}
                    </span>
                    <code className="mono-id">{p.id}</code>
                    <button className="btn" onClick={() => copy(p.id, p.id)}>
                      {copied === p.id ? "Copied" : "Copy"}
                    </button>
                  </div>
                ))
              )}

              <h4 className="rail-h">3 · Make it automatic — the daily loop</h4>
              <p className="empty" style={{ marginBottom: 8 }}>
                Drop two files into a repo and every agent session starts pre-briefed, coordinates through the
                work board, and hands over when done — no discipline required:
              </p>
              {projects.map((p) => (
                <div key={p.id} className="copyrow">
                  <span className="cdot" style={{ background: p.color ?? "#8b7cf6" }} />
                  <span className="truncate" style={{ flex: 1 }}>
                    {p.name}
                  </span>
                  <a className="btn" href={`/api/connect-kit?projectId=${p.id}&file=claude`} title="Drop into the repo root — teaches agents the full loop">
                    CLAUDE.md
                  </a>
                  <a className="btn" href={`/api/connect-kit?projectId=${p.id}&file=hooks`} title="Merge into .claude/settings.json — injects the briefing at session start">
                    Hooks
                  </a>
                  <a className="btn" href={`/api/connect-kit?projectId=${p.id}&file=commit-hook`} title="Save as .git/hooks/post-commit — every commit auto-syncs its files to the code mirror">
                    Git hook
                  </a>
                </div>
              ))}
              <p className="empty" style={{ marginTop: 6 }}>
                <code>CLAUDE.md</code> → repo root · <code>Hooks</code> → merge into <code>.claude/settings.json</code>{" "}
                (SessionStart injects this vault&apos;s briefing) · <code>Git hook</code> → save as{" "}
                <code>.git/hooks/post-commit</code> (each commit auto-syncs its changed files to the code mirror).
              </p>
              <div className="copyrow" style={{ marginTop: 10 }}>
                <span className="truncate" style={{ flex: 1 }}>
                  Bulk ingest — teach your agent to turn transcripts, docs, and exports into linked notes (
                  <code>import_notes</code>)
                </span>
                <a
                  className="btn"
                  href="/api/connect-kit?file=ingest-skill"
                  title="Save as ~/.claude/skills/vault-ingest/SKILL.md — then say /vault-ingest to your agent"
                >
                  Ingest skill
                </a>
              </div>
              <div className="copyrow">
                <span className="truncate" style={{ flex: 1 }}>
                  Vault-first everywhere — standing orders so every session searches the vault before asking you,
                  in any folder
                </span>
                <a
                  className="btn"
                  href="/api/connect-kit?file=global-claude"
                  title="Save as ~/.claude/CLAUDE.md (or append to it) — applies to all your Claude Code sessions"
                >
                  Global CLAUDE.md
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
