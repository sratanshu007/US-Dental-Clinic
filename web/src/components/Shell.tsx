"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, logout, session, type SessionUser } from "@/lib/api";

const IDLE_MINUTES = 15; // HIPAA: automatic logoff

const NAV: { href: string; label: string; badge?: boolean; crm?: boolean }[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/appointments", label: "Appointments" },
  { href: "/patients", label: "Patients" },
  { href: "/crm", label: "CRM", crm: true },
  { href: "/calls", label: "Calls" },
  { href: "/feedback", label: "Feedback" },
  { href: "/reports", label: "Daily report" },
  { href: "/notifications", label: "Notifications", badge: true },
  { href: "/settings", label: "Settings" },
];

export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [clinicName, setClinicName] = useState("");
  const [unread, setUnread] = useState(0);
  const [crmBadge, setCrmBadge] = useState(0);
  const [plan, setPlan] = useState<{ name: string; billingStatus: string; features: Record<string, boolean> } | null>(null);

  const [loadedClinicId, setLoadedClinicId] = useState<string | null>(null);

  useEffect(() => {
    const u = session.user;
    if (!u) {
      router.replace("/login");
      return;
    }
    setUser(u);
    const activeClinic = session.clinicId ?? u.clinicId ?? null;
    if (u.role === "SUPER_ADMIN" && !session.clinicId && path !== "/admin") {
      router.replace("/admin");
      return;
    }
    if ((u.role !== "SUPER_ADMIN" || session.clinicId) && (!clinicName || loadedClinicId !== activeClinic)) {
      api("/api/dashboard")
        .then((d) => {
          setClinicName(d.clinic.name);
          setLoadedClinicId(activeClinic);
          session.setTz(d.clinic.timezone);
          if (d.plan) setPlan(d.plan);
        })
        .catch(() => {});
    }
  }, [path, router, clinicName, loadedClinicId]);

  // unread notifications badge
  useEffect(() => {
    if (!user || (user.role === "SUPER_ADMIN" && !session.clinicId)) return;
    const load = () => {
      api<any[]>("/api/notifications?unread=1").then((n) => setUnread(n.length)).catch(() => {});
      if (plan?.features.crm !== false) api<any>("/api/crm/summary").then((s) => setCrmBadge(s.stages.NEW.count + s.tasks.overdue)).catch(() => {});
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [user, path, plan?.features.crm]);

  // idle logout
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => logout(), IDLE_MINUTES * 60_000);
    };
    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, []);

  if (!user) return null;
  const inClinic = user.role !== "SUPER_ADMIN" || !!session.clinicId;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Dental AI Receptionist
          <span>{inClinic ? clinicName || "…" : "Deific admin"}</span>
        </div>
        {user.role === "SUPER_ADMIN" && (
          <Link href="/admin" className={path === "/admin" ? "active" : ""} onClick={() => session.setClinic(null)}>
            All clinics
          </Link>
        )}
        {inClinic && plan && (
          <div style={{ padding: "0 18px 10px", fontSize: 12, color: "#9fb4cc" }}>
            <span style={{ background: "rgba(255,255,255,0.12)", borderRadius: 10, padding: "2px 8px", color: "#fff", fontWeight: 600 }}>{plan.name} plan</span>
          </div>
        )}
        {inClinic &&
          NAV.map((n) => {
            const locked = n.crm && plan?.features.crm === false;
            return (
              <Link key={n.href} href={locked ? "/settings?tab=plan" : n.href} className={path.startsWith(n.href) ? "active" : ""} title={locked ? "Included in Growth and Pro" : undefined}>
                {n.label}{locked && " 🔒"}
                {n.badge && unread > 0 && <span className="dot">{unread}</span>}
                {n.crm && !locked && crmBadge > 0 && <span className="dot">{crmBadge}</span>}
              </Link>
            );
          })}
        <div className="spacer" />
        <div className="who">
          {user.name}
          <br />
          {user.role.replace("_", " ").toLowerCase()}
          <br />
          <button className="link small" onClick={logout} style={{ color: "#9fb4cc", marginTop: 6 }}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">
        {inClinic && plan?.billingStatus === "PAST_DUE" && (
          <div className="alert" style={{ marginBottom: 14 }}>Payment failed — the AI keeps answering for now. Please update your card in <Link href="/settings?tab=plan">Settings → Plan &amp; billing</Link>.</div>
        )}
        {inClinic && plan?.billingStatus === "CANCELED" && (
          <div className="alert" style={{ marginBottom: 14 }}>Your subscription is canceled, so the AI receptionist is not answering calls. Reactivate in <Link href="/settings?tab=plan">Settings → Plan &amp; billing</Link> or email hello@deificdigital.com.</div>
        )}
        {children}
      </main>
    </div>
  );
}
