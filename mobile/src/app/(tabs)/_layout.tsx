import { Ionicons } from "@expo/vector-icons";
import { Redirect, useFocusEffect } from "expo-router";
import Tabs from "expo-router/tabs";
import { useCallback, useState } from "react";
import { C, Loading, type IconName } from "../../components/ui";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";

const icon = (name: IconName, active: IconName) => ({ color, focused }: { color: any; focused: boolean }) =>
  <Ionicons name={focused ? active : name} size={23} color={color} />;

export default function TabsLayout() {
  const { user, ready } = useAuth();
  const [badges, setBadges] = useState({ crm: 0, alerts: 0 });
  // The CRM tab only shows on plans that include it (Growth, Pro)
  const [crmOn, setCrmOn] = useState(true);

  const load = useCallback(() => {
    if (!user) return;
    api<any>("/api/dashboard").then((d) => setCrmOn(d.plan?.features?.crm !== false)).catch(() => {});
    api<any[]>("/api/notifications?unread=1").then((n) => setBadges((b) => ({ ...b, alerts: n.length }))).catch(() => {});
    api<any>("/api/crm/summary").then((s) => setBadges((b) => ({ ...b, crm: s.stages.NEW.count + s.tasks.overdue }))).catch(() => {});
  }, [user]);
  useFocusEffect(load);

  if (!ready) return <Loading />;
  if (!user) return <Redirect href="/login" />;

  return (
    <Tabs
      screenListeners={{ focus: load }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: C.brand,
        tabBarInactiveTintColor: C.faint,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        tabBarStyle: { borderTopColor: C.line, backgroundColor: "rgba(255,255,255,0.97)" },
        tabBarBadgeStyle: { backgroundColor: "#ef4444", fontSize: 10 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Today", tabBarIcon: icon("calendar-outline", "calendar") }} />
      <Tabs.Screen name="report" options={{ title: "Report", tabBarIcon: icon("bar-chart-outline", "bar-chart") }} />
      <Tabs.Screen name="crm" options={{ title: "CRM", href: crmOn ? undefined : null, tabBarIcon: icon("people-outline", "people"), tabBarBadge: badges.crm || undefined }} />
      <Tabs.Screen name="alerts" options={{ title: "Alerts", tabBarIcon: icon("notifications-outline", "notifications"), tabBarBadge: badges.alerts || undefined }} />
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: icon("ellipsis-horizontal-circle-outline", "ellipsis-horizontal-circle") }} />
    </Tabs>
  );
}
