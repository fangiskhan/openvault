"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const [mode, setMode] = useState<"password" | "account">("password");
  const [pw, setPw] = useState("");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body = mode === "password" ? { password: pw } : { username, token };
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        router.replace("/");
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(
        data.error === "account_not_approved"
          ? "Your account is pending — an owner or executive must approve it first."
          : mode === "password"
            ? "Incorrect password."
            : "Unknown username or token.",
      );
    } catch {
      setErr("Couldn't reach the server — is it running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 16 }}>
          <span className="dot" /> OpenVault
        </div>
        <div className="scope" style={{ marginBottom: 14, width: "100%" }}>
          <button type="button" className={mode === "password" ? "on" : ""} onClick={() => setMode("password")}>
            Workspace
          </button>
          <button type="button" className={mode === "account" ? "on" : ""} onClick={() => setMode("account")}>
            My account
          </button>
        </div>
        {mode === "password" ? (
          <>
            <p className="empty" style={{ marginBottom: 14 }}>Enter the workspace password.</p>
            <input
              className="input"
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="Password"
              autoFocus
            />
          </>
        ) : (
          <>
            <p className="empty" style={{ marginBottom: 14 }}>
              Sign in with your username and account token (<code>ovk_…</code>).
            </p>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              autoFocus
            />
            <input
              className="input"
              type="password"
              style={{ marginTop: 8 }}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Account token"
            />
          </>
        )}
        {err && <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>{err}</p>}
        <button
          className="btn btn-accent"
          style={{ marginTop: 16, width: "100%", justifyContent: "center" }}
          disabled={busy}
        >
          {busy ? "…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
