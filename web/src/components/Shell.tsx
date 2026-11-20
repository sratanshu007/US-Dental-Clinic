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

  useEffect(() => {
    const u = session.user;
    if (!u) {
      router.replace("/login");
      return;
    }
    setUser(u);
    if (u.role === "SUPER_ADMIN" && !session.clinicId && path !== "/admin") {
      router.replace("/admin");
      return;
    }
    if (u.role !== "SUPER_ADMIN" || session.clinicId) {
      api("/api/dashboard")
        .then((d) => {
          setClinicName(d.clinic.name);
          session.setTz(d.clinic.timezone);
        })
        .catch(() => {});
    }
  }, [path, router]);

  // unread notifications badge
  useEffect(() => {
    if (!user || (user.role === "SUPER_ADMIN" && !session.clinicId)) return;
    const load = () => {
      api<any[]>("/api/notifications?unread=1").then((n) => setUnread(n.length)).catch(() => {});
      api<any>("/api/crm/summary").then((s) => setCrmBadge(s.stages.NEW.count + s.tasks.overdue)).catch(() => {});
    };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [user, path]);

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
        {inClinic &&
          NAV.map((n) => (
            <Link key={n.href} href={n.href} className={path.startsWith(n.href) ? "active" : ""}>
              {n.label}
              {n.badge && unread > 0 && <span className="dot">{unread}</span>}
              {n.crm && crmBadge > 0 && <span className="dot">{crmBadge}</span>}
            </Link>
          ))}
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
      <main className="main">{children}</main>
    </div>
  );
}
