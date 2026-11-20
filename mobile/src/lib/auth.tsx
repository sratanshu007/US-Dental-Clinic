import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { api, clearSession, loadSession, logout, saveSession, setClinicTz, setSignedOutHandler, type User } from "./api";
import { registerForPush } from "./push";

const LOCK_AFTER_MS = 15 * 60_000; // HIPAA automatic logoff: 15 min in the background

interface AuthState {
  user: User | null;
  ready: boolean;
  signIn: (t: { accessToken: string; refreshToken: string; user: User }) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState>({ user: null, ready: false, signIn: async () => {}, signOut: async () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const backgroundedAt = useRef<number | null>(null);

  const afterSignIn = useCallback(async () => {
    try {
      const d = await api("/api/dashboard");
      setClinicTz(d.clinic.timezone);
    } catch {
      /* offline */
    }
    registerForPush().catch(() => {});
  }, []);

  useEffect(() => {
    setSignedOutHandler(() => setUser(null));
    loadSession().then(async (u) => {
      if (u) {
        try {
          // Validate the stored session (refreshes the token if needed)
          await api("/auth/me");
          setUser(u);
          afterSignIn();
        } catch {
          await clearSession();
        }
      }
      setReady(true);
    });
  }, [afterSignIn]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "background" || s === "inactive") backgroundedAt.current = Date.now();
      if (s === "active" && backgroundedAt.current && Date.now() - backgroundedAt.current > LOCK_AFTER_MS) {
        logout();
      }
      if (s === "active") backgroundedAt.current = null;
    });
    return () => sub.remove();
  }, []);

  const signIn = useCallback(async (t: { accessToken: string; refreshToken: string; user: User }) => {
    await saveSession(t);
    setUser(t.user);
    afterSignIn();
  }, [afterSignIn]);

  const signOut = useCallback(async () => {
    await logout();
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, ready, signIn, signOut }}>{children}</Ctx.Provider>;
}
