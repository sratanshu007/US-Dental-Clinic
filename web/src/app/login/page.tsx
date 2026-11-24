"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, session } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const adminEmail = process.env.NEXT_PUBLIC_ADMIN_EMAIL || "";
  const adminPass = process.env.NEXT_PUBLIC_ADMIN_PASSWORD || "";
  const ownerEmail = process.env.NEXT_PUBLIC_OWNER_EMAIL || "";
  const ownerPass = process.env.NEXT_PUBLIC_OWNER_PASSWORD || "";

  const [email, setEmail] = useState(adminEmail || ownerEmail || "");
  const [password, setPassword] = useState(adminPass || ownerPass || "");
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(params.get("expired") ? "Your session ended. Please sign in again." : null);
  const [busy, setBusy] = useState(false);

  const done = (t: any) => {
    session.save(t);
    router.replace(t.user.role === "SUPER_ADMIN" ? "/admin" : "/dashboard");
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!mfaToken) {
        const r = await api("/auth/login", { body: { email, password } });
        if (r.mfaRequired) setMfaToken(r.mfaToken);
        else done(r);
      } else {
        done(await api("/auth/mfa/verify", { body: { mfaToken, code } }));
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <h1>Dental AI Receptionist</h1>
        <p className="muted" style={{ marginTop: 0 }}>Sign in to your clinic dashboard</p>
        {error && <div className="alert">{error}</div>}
        {!mfaToken ? (
          <>
            <div className="field">
              <label>Email</label>
              <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label>Password</label>
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {(adminEmail || ownerEmail) && (
              <div style={{ display: "flex", gap: "8px", marginBottom: "14px", flexWrap: "wrap" }}>
                {adminEmail && (
                  <button
                    type="button"
                    className="secondary small"
                    style={{ fontSize: "12px", padding: "4px 8px" }}
                    onClick={() => { setEmail(adminEmail); setPassword(adminPass); }}
                  >
                    Fill Super Admin
                  </button>
                )}
                {ownerEmail && (
                  <button
                    type="button"
                    className="secondary small"
                    style={{ fontSize: "12px", padding: "4px 8px" }}
                    onClick={() => { setEmail(ownerEmail); setPassword(ownerPass); }}
                  >
                    Fill Clinic Owner
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="field">
            <label>6-digit code from your authenticator app</label>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required />
          </div>
        )}
        <button className="primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
          {busy ? "Please wait…" : mfaToken ? "Verify" : "Sign in"}
        </button>
        <p className="small muted" style={{ marginBottom: 0 }}>
          This system contains protected health information. Access is logged.
        </p>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
