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
  const [inviteUser, setInviteUser] = useState("");
  const [inviteName, setInviteName] = useState("");
  // One-time token reveal: { username, token } — tokens are stored hashed, so
  // this is the only moment the plaintext exists. Copy it or lose it.
  const [reveal, setReveal] = useState<{ username: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  const invite = async () => {
    const username = inviteUser.trim();
    if (!username) return;
    setBusy("invite");
    try {
      const r = await api("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, displayName: inviteName.trim() || undefined }),
      });
      setReveal({ username: r.username, token: r.token });
      setInviteUser("");
      setInviteName("");
      setErr(null);
      await load();
    } catch {
      setErr("Could not create the account — the username may be taken, reserved, or invalid.");
    } finally {
      setBusy(null);
    }
  };

  const regenerate = async (id: string) => {
    setBusy(id);
    try {
      const r = await api(`/api/accounts/${id}/token`, { method: "POST" });
      setReveal({ username: r.username, token: r.token });
      setErr(null);
    } catch {
      setErr("Could not regenerate the token — owner/executive access required.");
    } finally {
      setBusy(null);
    }
  };

  const copyToken = async () => {
    if (!reveal) return;
    try {
      await navigator.clipboard.writeText(reveal.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  const pending = accounts.filter((a) => a.status === "pending");
  const members = accounts.filter((a) => a.status !== "pending");
  const nameOf = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.username ?? id : "—");

  return (
    <div>
      <h2>Access Control</h2>
      {err && <p className="spx-meta" style={{ color: "var(--spx-magenta)" }}>{err}</p>}

      {reveal && (
        <div className="spx-card" style={{ background: "var(--spx-lime)" }}>
          <span>
            <span className="spx-user">{reveal.username}</span>
            <br />
            <span className="spx-meta">
              Token for this account — <b>shown once, stored only as a hash.</b> Copy it now.
            </span>
            <br />
            <code style={{ fontSize: 12, wordBreak: "break-all" }}>{reveal.token}</code>
          </span>
          <span className="spx-spacer" />
          <button className="spx-btn" onClick={copyToken}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="spx-btn ghost" onClick={() => setReveal(null)}>
            Done
          </button>
        </div>
      )}

      <h3>Add a member</h3>
      <div className="spx-card">
        <input
          className="spx-input"
          placeholder="username (their agent's identity)"
          value={inviteUser}
          onChange={(e) => setInviteUser(e.target.value)}
        />
        <input
          className="spx-input"
          placeholder="display name (optional)"
          value={inviteName}
          onChange={(e) => setInviteName(e.target.value)}
        />
        <button className="spx-btn" disabled={busy === "invite" || !inviteUser.trim()} onClick={invite}>
          {busy === "invite" ? "…" : "Create"}
        </button>
      </div>
      <p className="spx-meta">
        Creates a pending account and reveals its token once — hand both to your teammate, then approve below.
      </p>

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
          <button
            className="spx-btn ghost"
            disabled={busy === a.id}
            title="Issue a fresh token (the old one stops working)"
            onClick={() => regenerate(a.id)}
          >
            New Token
          </button>
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
