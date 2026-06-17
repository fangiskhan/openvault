"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(false);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    setBusy(false);
    if (res.ok) router.replace("/");
    else setErr(true);
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 16 }}>
          <span className="dot" /> OpenVault
        </div>
        <p className="empty" style={{ marginBottom: 14 }}>Enter the workspace password.</p>
        <input
          className="input"
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Password"
          autoFocus
        />
        {err && <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>Incorrect password.</p>}
        <button
          className="btn btn-accent"
          style={{ marginTop: 16, width: "100%", justifyContent: "center" }}
          disabled={busy}
        >
          {busy ? "…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
