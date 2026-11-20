import * as Notifications from "expo-notifications";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AuthProvider } from "../lib/auth";

/** Map a notification's link (from the API) to an app screen. */
function routeFor(link?: string): string {
  if (!link) return "/alerts";
  if (link.startsWith("/leads") || link.startsWith("/crm")) return "/crm";
  if (link.startsWith("/reports")) return "/report";
  if (link.startsWith("/appointments")) return "/";
  return "/alerts";
}

export default function RootLayout() {
  useEffect(() => {
    try {
      const sub = Notifications.addNotificationResponseReceivedListener((response) => {
        const link = response.notification.request.content.data?.link as string | undefined;
        router.push(routeFor(link) as any);
      });
      return () => {
        try {
          sub.remove();
        } catch {}
      };
    } catch {
      // In Expo Go or unsupported platforms
    }
  }, []);

  return (
    <AuthProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}
