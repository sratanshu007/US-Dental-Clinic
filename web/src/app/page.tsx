"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { session } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const u = session.user;
    if (!u) router.replace("/login");
    else router.replace(u.role === "SUPER_ADMIN" && !session.clinicId ? "/admin" : "/dashboard");
  }, [router]);
  return null;
}
