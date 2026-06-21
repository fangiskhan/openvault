"use client";

import { useCallback, useEffect, useState } from "react";

type Account = {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
  status: string;
  approvedById: string | null;
  approvedAt: string | null;
  createdAt: string;
};
type Audit = { id: string; action: string; actor: string | null; target: string | null; createdAt: string };

async function api(path: string, opts?: RequestInit) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// Owner/executive panel: see who has requested access, approve them, appoint
// executives, and read the permanent approval record. Styled to match the
// SPX6900 website (game-UI: neon-on-paper, Orbitron, chunky offset shadows).
export default function AccountsAdmin() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, ev] = await Promise.all([api("/api/accounts"), api("/api/audit").catch(() => [])]);
      setAccounts(a);
      setAudit(ev);
      setErr(null);
    } catch {
      setErr("Not authorized — sign in as the owner (APP_PASSWORD) or an executive to manage accounts.");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const approve = async (id: string) => {
    setBusy(id);
    try {
      await api(`/api/accounts/${id}/approve`, { method: "POST" });
      await load();
    } finally {
      setBusy(null);
    }
  };
  const appoint = async (id: string, role: string) => {
    setBusy(id);
    try {
      await api(`/api/accounts/${id}/role`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const pending = accounts.filter((a) => a.status === "pending");
  const members = accounts.filter((a) => a.status !== "pending");
  const nameOf = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.username ?? id : "—");

  return (
    <div>
      <h2>Access Control</h2>
      {err && <p className="spx-meta" style={{ color: "var(--spx-magenta)" }}>{err}</p>}

      <h3>Pending — {pending.length}</h3>
      {pending.length === 0 && <p className="spx-meta">No accounts awaiting approval.</p>}
      {pending.map((a) => (
        <div key={a.id} className="spx-card">
          <span className="spx-tag pending">PENDING</span>
          <span>
            <span className="spx-user">{a.username}</span>
            {a.displayName && <span className="spx-meta"> · {a.displayName}</span>}
            <br />
            <span className="spx-meta">requested {new Date(a.createdAt).toLocaleString()}</span>
          </span>
          <span className="spx-spacer" />
          <button className="spx-btn" disabled={busy === a.id} onClick={() => approve(a.id)}>
            {busy === a.id ? "…" : "Approve"}
          </button>
        </div>
      ))}

      <h3>Members — {members.length}</h3>
      {members.map((a) => (
        <div key={a.id} className="spx-card">
          <span className={`spx-tag ${a.role}`}>{a.role.toUpperCase()}</span>
          <span>
            <span className="spx-user">{a.username}</span>
            <br />
            <span className="spx-meta">
              approved by {nameOf(a.approvedById)}
              {a.approvedAt ? ` · ${new Date(a.approvedAt).toLocaleDateString()}` : ""}
            </span>
          </span>
          <span className="spx-spacer" />
          {a.role === "member" && (
            <button className="spx-btn ghost" disabled={busy === a.id} onClick={() => appoint(a.id, "executive")}>
              Make Exec
            </button>
          )}
          {a.role === "executive" && (
            <button className="spx-btn ghost" disabled={busy === a.id} onClick={() => appoint(a.id, "member")}>
              Revoke Exec
            </button>
          )}
        </div>
      ))}

      <h3>Approval Record</h3>
      <ul className="spx-audit">
        {audit.filter((e) => e.action === "approve" || e.action.startsWith("appoint")).slice(0, 30).map((e) => (
          <li key={e.id}>
            {e.createdAt.slice(0, 10)} · <b>{e.actor}</b> {e.action} → <b>{e.target}</b>
          </li>
        ))}
        {audit.length === 0 && <li className="spx-meta">No records yet.</li>}
      </ul>
    </div>
  );
}
