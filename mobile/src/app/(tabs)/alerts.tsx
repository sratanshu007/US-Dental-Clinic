import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { C, Card, Chips, Empty, ErrorText, Header, type IconName, s } from "../../components/ui";
import { api, fmtTime, relDay } from "../../lib/api";

const STYLE: Record<string, [string, string, IconName]> = {
  NEW_BOOKING: ["#e8efff", "#2563eb", "calendar"],
  NEW_LEAD: ["#f1ebff", "#6d28d9", "person-add"],
  TASKS: ["#fdf3e2", "#b45309", "alarm"],
  DAILY_REPORT: ["#e6f4f2", "#0f766e", "bar-chart"],
  FEEDBACK: ["#fff4d6", "#d97706", "star"],
  NO_SHOW: ["#fdecea", "#b42318", "close-circle"],
  CANCELLED: ["#fdf3e2", "#b45309", "calendar-clear"],
  TRANSFER: ["#e8efff", "#2563eb", "call"],
  SMS: ["#e6f4f2", "#0f766e", "chatbubble"],
};
const routeFor = (link?: string) => (!link ? null : link.startsWith("/crm") || link.startsWith("/leads") ? "/crm" : link.startsWith("/reports") ? "/report" : link.startsWith("/appointments") ? "/" : null);

export default function Alerts() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const n = await api<any[]>(`/api/notifications${filter ? `?${filter}` : ""}`);
      setRows(n);
      setError(null);
      if (!filter.includes("unread") && n.some((x) => !x.readAt)) api("/api/notifications/read-all", { method: "POST" }).catch(() => {});
    } catch (e: any) {
      setError(e.message);
    }
  }, [filter]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const unread = (rows ?? []).filter((n) => !n.readAt).length;
  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      <ErrorText error={error} />
      <FlatList
        data={rows ?? []}
        keyExtractor={(n) => n.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        ListHeaderComponent={
          <View>
            <Header over={unread ? `${unread} unread` : "All caught up"} title="Alerts" />
            <Chips value={filter} onChange={setFilter} options={[["", "All"], ["unread=1", "Unread"], ["type=NEW_BOOKING", "Bookings"], ["type=NEW_LEAD", "Leads"], ["type=DAILY_REPORT", "Reports"]]} />
          </View>
        }
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.brand} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={rows ? <Empty icon="notifications-off-outline" text="No alerts here." /> : undefined}
        renderItem={({ item: n }) => {
          const [bg, fg, icon] = STYLE[n.type] ?? STYLE.DAILY_REPORT;
          const to = routeFor(n.link);
          return (
            <Card onPress={to ? () => router.push(to as any) : undefined} style={{ flexDirection: "row", gap: 12, padding: 12, borderWidth: n.readAt ? 0 : 1.5, borderColor: "#99e0d6" }}>
              <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name={icon} size={18} color={fg} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontWeight: "700", color: C.ink, fontSize: 14 }}>{n.title}</Text>
                <Text style={{ color: C.text, marginTop: 2, fontSize: 13 }}>{n.body}</Text>
                <Text style={[s.small, { fontSize: 11.5, marginTop: 4 }]}>{relDay(n.createdAt)}, {fmtTime(n.createdAt)}</Text>
              </View>
            </Card>
          );
        }}
      />
    </SafeAreaView>
  );
}
