// Today: the day's appointments. Front desk taps "Came" or "No-show".
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Btn, C, Card, Empty, ErrorText, GRADIENT, Header, IconBtn, Pill, Segmented, s } from "../../components/ui";
import { addDays, api, fmtDate, fmtTime, patientName, todayISO } from "../../lib/api";
import { useAuth } from "../../lib/auth";

type Seg = "all" | "wait" | "SHOWED" | "NO_SHOW";
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };

export default function Today() {
  const { user } = useAuth();
  const [date, setDate] = useState(todayISO());
  const [seg, setSeg] = useState<Seg>("all");
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api<any[]>(`/api/appointments?from=${date}&to=${date}`));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [date]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function mark(id: string, status: string) {
    setBusy(id);
    try {
      await api(`/api/appointments/${id}/status`, { method: "PATCH", body: { status } });
      await load();
    } catch (e: any) {
      Alert.alert("Could not update", e.message);
    } finally {
      setBusy(null);
    }
  }

  const active = (rows ?? []).filter((a) => !["RESCHEDULED", "CANCELLED"].includes(a.status));
  const came = active.filter((a) => a.status === "SHOWED").length;
  const noShow = active.filter((a) => a.status === "NO_SHOW").length;
  const waiting = active.length - came - noShow;
  const list = active.filter((a) => seg === "all" || (seg === "wait" ? ["BOOKED", "CONFIRMED"].includes(a.status) : a.status === seg));
  const isToday = date === todayISO();
  const total = Math.max(1, active.length);
  const initials = (user?.name ?? "").split(" ").map((x) => x[0]).join("").slice(0, 2).toUpperCase();

  const top = (
    <View>
      <Header
        over={isToday ? new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "Appointments"}
        title={isToday ? greeting() : fmtDate(`${date}T12:00:00`)}
        initials={initials}
        right={
          <View style={s.row}>
            <IconBtn icon="chevron-back" onPress={() => setDate(addDays(date, -1))} />
            <IconBtn icon="chevron-forward" onPress={() => setDate(addDays(date, 1))} />
          </View>
        }
      />
      <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 22, padding: 18, marginBottom: 14 }}>
        <Text style={{ color: "rgba(255,255,255,0.85)", fontSize: 13 }}>{isToday ? "Today's patients" : "Patients"}</Text>
        <Text style={{ color: "#fff", fontSize: 28, fontWeight: "800", marginVertical: 4 }}>{came} of {active.length} seen</Text>
        <View style={{ height: 8, borderRadius: 99, backgroundColor: "rgba(255,255,255,0.25)", flexDirection: "row", overflow: "hidden", marginTop: 6 }}>
          <View style={{ width: `${(came / total) * 100}%`, backgroundColor: "#bbf7d0" }} />
          <View style={{ width: `${(noShow / total) * 100}%`, backgroundColor: "#fca5a5" }} />
        </View>
        <View style={{ flexDirection: "row", gap: 14, marginTop: 10 }}>
          <Text style={{ color: "#dcfce7", fontSize: 12.5 }}>● {came} came</Text>
          <Text style={{ color: "#fee2e2", fontSize: 12.5 }}>● {noShow} no-show</Text>
          <Text style={{ color: "#e2f7f4", fontSize: 12.5 }}>● {waiting} waiting</Text>
        </View>
        {!isToday && (
          <Pressable onPress={() => setDate(todayISO())} style={{ marginTop: 10 }}>
            <Text style={{ color: "#fff", fontWeight: "700" }}>Back to today →</Text>
          </Pressable>
        )}
      </LinearGradient>
      <Segmented<Seg> value={seg} onChange={setSeg} options={[["all", "All"], ["wait", "Waiting"], ["SHOWED", "Came"], ["NO_SHOW", "No-show"]]} />
    </View>
  );

  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      <ErrorText error={error} />
      <FlatList
        data={list}
        keyExtractor={(a) => a.id}
        ListHeaderComponent={top}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.brand} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={rows ? <Empty icon="calendar-clear-outline" text="No appointments here." /> : undefined}
        renderItem={({ item: a }) => {
          const started = new Date(a.startAt).getTime() <= Date.now();
          const canMark = ["BOOKED", "CONFIRMED"].includes(a.status) && started;
          const [hm, ap] = fmtTime(a.startAt).split(" ");
          return (
            <Card style={{ flexDirection: "row", gap: 12, padding: 12 }}>
              <View style={{ width: 54, alignItems: "center", borderRightWidth: 1, borderRightColor: C.line, paddingRight: 10 }}>
                <Text style={{ fontSize: 16, fontWeight: "800", color: C.ink }}>{hm}</Text>
                <Text style={{ fontSize: 11, color: C.faint }}>{ap}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={[s.row, { justifyContent: "space-between" }]}>
                  <Text style={[s.name, { flexShrink: 1 }]} numberOfLines={1}>{patientName(a.patient)}</Text>
                  <Pill value={a.status} />
                </View>
                <Text style={[s.small, { marginTop: 2 }]} numberOfLines={1}>
                  {[a.service?.name ?? a.reason, a.provider ? `Dr. ${a.provider.name.split(" ").pop()}` : null].filter(Boolean).join(" · ")}
                </Text>
                <View style={[s.row, { marginTop: 4, gap: 6 }]}>
                  {a.patient?.isNew && <Pill value="APPT" label="New patient" />}
                  {a.source !== "STAFF" && (
                    <View style={[s.row, { gap: 3 }]}><Ionicons name="sparkles" size={11} color={C.brand} /><Text style={{ fontSize: 11, color: C.brand, fontWeight: "600" }}>Booked by AI</Text></View>
                  )}
                </View>
                {canMark && (
                  <View style={[s.row, { marginTop: 10 }]}>
                    <Btn style={{ flex: 1 }} kind="green" icon="checkmark" title="Came" disabled={busy === a.id} onPress={() => mark(a.id, "SHOWED")} />
                    <Btn style={{ flex: 1 }} kind="red" icon="close" title="No-show" disabled={busy === a.id} onPress={() => mark(a.id, "NO_SHOW")} />
                  </View>
                )}
                {(a.status === "SHOWED" || a.status === "NO_SHOW") && (
                  <Text style={{ marginTop: 8, color: C.brand, fontSize: 12.5, fontWeight: "600" }} onPress={() => mark(a.id, "BOOKED")}>
                    Undo · {a.status === "NO_SHOW" ? "AI will call to rebook" : "AI will ask for feedback"}
                  </Text>
                )}
              </View>
            </Card>
          );
        }}
      />
    </SafeAreaView>
  );
}
