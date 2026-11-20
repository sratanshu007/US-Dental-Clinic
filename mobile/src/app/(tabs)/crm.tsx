// CRM: new leads to call back and follow-up tasks.
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, FlatList, Linking, Pressable, RefreshControl, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar, Btn, C, Card, Chips, Empty, ErrorText, Header, Kpi, Pill, Segmented, s } from "../../components/ui";
import { api, fmtPhone, fmtTime, money, relDay } from "../../lib/api";

type View_ = "leads" | "tasks";

export default function Crm() {
  const [view, setView] = useState<View_>("leads");
  const [stage, setStage] = useState("NEW,CONTACTED");
  const [taskFilter, setTaskFilter] = useState("today");
  const [q, setQ] = useState("");
  const [leads, setLeads] = useState<any[] | null>(null);
  const [tasks, setTasks] = useState<any[] | null>(null);
  const [sum, setSum] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [l, t, sm] = await Promise.all([
        api(`/api/crm/leads?stage=${stage}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
        api<any[]>(`/api/crm/tasks?status=${taskFilter}`),
        api("/api/crm/summary"),
      ]);
      setLeads(l.leads);
      setTasks(t);
      setSum(sm);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [stage, taskFilter, q]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function callBack(l: any) {
    Linking.openURL(`tel:${l.phone}`).catch(() => {});
    try {
      await api(`/api/crm/leads/${l.id}/activities`, { body: { type: "CALL", text: "Called from the mobile app." } });
      load();
    } catch { /* ignore */ }
  }
  async function booked(l: any) {
    try {
      await api(`/api/crm/leads/${l.id}`, { method: "PATCH", body: { stage: "APPT" } });
      load();
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
  }
  async function toggleTask(t: any) {
    await api(`/api/crm/tasks/${t.id}`, { method: "PATCH", body: { done: !t.doneAt } }).catch(() => {});
    load();
  }

  const top = (
    <View>
      <Header over="CRM" title="Follow up" />
      {sum && (
        <View style={[s.row, { marginBottom: 12 }]}>
          <Kpi icon="trending-up-outline" label="Open pipeline" value={money(sum.openPipeline)} />
          <Kpi icon="alarm-outline" label="Due today" value={sum.tasks.dueToday} color={sum.tasks.overdue ? "#dc2626" : undefined} />
        </View>
      )}
      <Segmented<View_> value={view} onChange={setView} options={[["leads", `Leads${sum ? ` · ${sum.stages.NEW.count + sum.stages.CONTACTED.count}` : ""}`], ["tasks", `Tasks${sum?.tasks.overdue ? ` · ${sum.tasks.overdue} late` : ""}`]]} />
      {view === "leads" ? (
        <>
          <View style={[s.row, { backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12, marginBottom: 10 }]}>
            <Ionicons name="search" size={16} color={C.faint} />
            <TextInput placeholder="Search name, phone, interest" placeholderTextColor={C.faint} value={q} onChangeText={setQ} onSubmitEditing={load} returnKeyType="search" style={{ flex: 1, paddingVertical: 10, fontSize: 15, color: C.ink }} />
          </View>
          <Chips value={stage} onChange={setStage} options={[["NEW,CONTACTED", "Open leads"], ["NEW", "New"], ["CONTACTED", "Contacted"], ["APPT,PLAN", "In progress"], ["WON", "Won"]]} />
        </>
      ) : (
        <Chips value={taskFilter} onChange={setTaskFilter} options={[["today", "Due today"], ["overdue", "Overdue"], ["open", "All open"], ["done", "Done"]]} />
      )}
    </View>
  );

  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      <ErrorText error={error} />
      <FlatList
        data={(view === "leads" ? leads : tasks) ?? []}
        keyExtractor={(x) => x.id}
        ListHeaderComponent={top}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.brand} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={(view === "leads" ? leads : tasks) ? <Empty icon="checkmark-done-outline" text={view === "leads" ? "No leads here." : "Nothing due. Nice work!"} /> : undefined}
        renderItem={({ item }) =>
          view === "leads" ? (
            <Card onPress={() => router.push(`/lead/${item.id}`)}>
              <View style={[s.row, { gap: 10 }]}>
                <Avatar name={item.name ?? "?"} size={40} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.name} numberOfLines={1}>{item.name ?? fmtPhone(item.phone)}</Text>
                  <Text style={s.small}>{item.source} · {relDay(item.createdAt)}</Text>
                </View>
                <Pill value={item.stage} />
              </View>
              <Text style={{ color: C.text, marginTop: 10, fontSize: 14 }}>{item.interest}</Text>
              <View style={[s.row, { marginTop: 4, justifyContent: "space-between" }]}>
                <Text style={{ color: C.brand, fontWeight: "700" }}>{money(item.value)}</Text>
                {item.nextTask && (
                  <Text style={{ fontSize: 12, color: new Date(item.nextTask.dueAt) < new Date() ? "#dc2626" : C.muted, fontWeight: "600" }}>
                    ⏰ {relDay(item.nextTask.dueAt)} {fmtTime(item.nextTask.dueAt)}
                  </Text>
                )}
              </View>
              {["NEW", "CONTACTED"].includes(item.stage) && (
                <View style={[s.row, { marginTop: 10 }]}>
                  <Btn style={{ flex: 1 }} kind="primary" icon="call" title="Call back" onPress={() => callBack(item)} />
                  <Btn style={{ flex: 1 }} icon="calendar-outline" title="Booked" onPress={() => booked(item)} />
                </View>
              )}
            </Card>
          ) : (
            <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Pressable onPress={() => toggleTask(item)} hitSlop={10}>
                <Ionicons name={item.doneAt ? "checkmark-circle" : "ellipse-outline"} size={26} color={item.doneAt ? C.green : C.faint} />
              </Pressable>
              <Pressable style={{ flex: 1 }} onPress={() => router.push(`/lead/${item.lead.id}`)}>
                <Text style={[s.name, { fontSize: 14.5 }, item.doneAt && { textDecorationLine: "line-through", color: C.faint }]}>{item.title}</Text>
                <Text style={s.small}>{item.lead.name ?? fmtPhone(item.lead.phone)} · {item.type.toLowerCase()}</Text>
              </Pressable>
              <Text style={{ fontSize: 12, fontWeight: "700", color: item.overdue ? "#dc2626" : C.muted }}>{relDay(item.dueAt)}{"\n"}{fmtTime(item.dueAt)}</Text>
            </Card>
          )
        }
      />
    </SafeAreaView>
  );
}
