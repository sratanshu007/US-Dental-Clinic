"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, getApiUrl, sanitizeApiUrl, session } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();

  // Read login credentials dynamically from environment (.env.local / Render env)
  const envEmail = process.env.NEXT_PUBLIC_LOGIN_EMAIL ?? "";
  const envPassword = process.env.NEXT_PUBLIC_LOGIN_PASSWORD ?? "";

  const [email, setEmail] = useState(envEmail);
  const [password, setPassword] = useState(envPassword);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(params.get("expired") ? "Your session ended. Please sign in again." : null);
  const [busy, setBusy] = useState(false);
  const [apiEndpoint, setApiEndpoint] = useState("");

  useEffect(() => {
    setApiEndpoint(getApiUrl());
  }, []);

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

  const fillEnvCredentials = () => {
    if (envEmail) setEmail(envEmail);
    if (envPassword) setPassword(envPassword);
  };

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
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@your-clinic.com"
                required
              />
            </div>
            <div className="field">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <label>Password</label>
                {envEmail && (email !== envEmail || password !== envPassword) && (
                  <button
                    type="button"
                    onClick={fillEnvCredentials}
                    className="small"
                    style={{ fontSize: 11, padding: "2px 6px", border: "none", background: "none", color: "var(--brand)" }}
                  >
                    Reset to .env
                  </button>
                )}
              </div>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                required
              />
            </div>
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

        {envEmail && (
          <p className="small muted" style={{ marginTop: 10, textAlign: "center", fontSize: 11 }}>
            💡 Credentials configured from environment variables.
          </p>
        )}

        <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--line)", fontSize: 11, color: "var(--muted)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>API: <code style={{ fontSize: 10 }}>{apiEndpoint || "not set"}</code></span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => {
                const custom = prompt("Enter your Render dental-api URL (e.g. https://dental-api-7h2u.onrender.com):", apiEndpoint);
                if (custom !== null) {
                  const sanitized = sanitizeApiUrl(custom);
                  if (sanitized) {
                    localStorage.setItem("dai.api_url", sanitized);
                    setApiEndpoint(sanitized);
                  } else {
                    localStorage.removeItem("dai.api_url");
                    setApiEndpoint(getApiUrl());
                  }
                }
              }}
              style={{ fontSize: 10, padding: "2px 6px", background: "none", border: "1px solid var(--line)", borderRadius: 4, cursor: "pointer", color: "var(--brand)" }}
            >
              Change
            </button>
            <button
              type="button"
              onClick={() => {
                localStorage.removeItem("dai.api_url");
                setApiEndpoint(getApiUrl());
              }}
              style={{ fontSize: 10, padding: "2px 6px", background: "none", border: "1px solid var(--line)", borderRadius: 4, cursor: "pointer", color: "var(--muted)" }}
            >
              Reset
            </button>
          </div>
        </div>

        <p className="small muted" style={{ marginBottom: 0, marginTop: 8 }}>
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
