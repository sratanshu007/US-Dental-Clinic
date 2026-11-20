// CRM contact detail: stage, tasks, notes and activity timeline.
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar, Btn, C, Card, ErrorText, IconBtn, Loading, Pill, Section, STATUS, s } from "../../components/ui";
import { api, fmtPhone, fmtTime, money, relDay } from "../../lib/api";

const STAGES = ["NEW", "CONTACTED", "APPT", "PLAN", "WON", "LOST"];
const ICON: Record<string, any> = { CALL: "call-outline", SMS: "chatbubble-outline", EMAIL: "mail-outline", NOTE: "document-text-outline", APPT: "calendar-outline", STAGE: "swap-horizontal-outline", TASK: "checkmark-done-outline", CREATED: "add-circle-outline" };

export default function Lead() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [c, setC] = useState<any>(null);
  const [note, setNote] = useState("");
  const [task, setTask] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setC(await api(`/api/crm/leads/${id}`));
    } catch (e: any) {
      setError(e.message);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
  };

  if (!c) return <SafeAreaView style={s.screen}>{error ? <ErrorText error={error} /> : <Loading />}</SafeAreaView>;

  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <View style={[s.row, { marginBottom: 12 }]}>
            <IconBtn icon="chevron-back" onPress={() => router.back()} />
          </View>
          <Card style={{ alignItems: "center", paddingVertical: 20 }}>
            <Avatar name={c.name ?? "?"} size={64} />
            <Text style={{ fontSize: 22, fontWeight: "800", color: C.ink, marginTop: 10 }}>{c.name ?? "Unknown"}</Text>
            <Text style={s.small}>{fmtPhone(c.phone)} · {c.source}</Text>
            <View style={[s.row, { marginTop: 8 }]}>
              <Pill value={c.stage} />
              <Text style={{ color: C.brand, fontWeight: "800" }}>{money(c.value)}</Text>
            </View>
            {c.interest && <Text style={{ marginTop: 10, color: C.text, textAlign: "center" }}>{c.interest}</Text>}
            <View style={[s.row, { marginTop: 14, alignSelf: "stretch" }]}>
              <Btn style={{ flex: 1 }} kind="primary" icon="call" title="Call" onPress={() => {
                Linking.openURL(`tel:${c.phone}`).catch(() => {});
                run(() => api(`/api/crm/leads/${id}/activities`, { body: { type: "CALL", text: "Called from the mobile app." } }));
              }} />
              <Btn style={{ flex: 1 }} icon="chatbubble-outline" title="Text" onPress={() => {
                Linking.openURL(`sms:${c.phone}`).catch(() => {});
                run(() => api(`/api/crm/leads/${id}/activities`, { body: { type: "SMS", text: "Sent a text from the mobile app." } }));
              }} />
            </View>
          </Card>

          <Section title="Stage" />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {STAGES.map((st) => {
              const on = c.stage === st, b = STATUS[st];
              return (
                <Pressable key={st} onPress={() => run(() => api(`/api/crm/leads/${id}`, { method: "PATCH", body: { stage: st } }))}
                  style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: on ? b.fg : "#fff", borderWidth: 1, borderColor: on ? b.fg : C.line }}>
                  <Text style={{ fontSize: 12.5, fontWeight: "700", color: on ? "#fff" : C.muted }}>{b.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Section title="Follow-up tasks" />
          {c.tasks.length === 0 && <Text style={s.small}>No tasks yet.</Text>}
          {c.tasks.map((t: any) => (
            <Card key={t.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 12 }}>
              <Pressable hitSlop={10} onPress={() => run(() => api(`/api/crm/tasks/${t.id}`, { method: "PATCH", body: { done: !t.doneAt } }))}>
                <Ionicons name={t.doneAt ? "checkmark-circle" : "ellipse-outline"} size={24} color={t.doneAt ? C.green : C.faint} />
              </Pressable>
              <Text style={[{ flex: 1, color: C.ink, fontSize: 14.5 }, t.doneAt && { textDecorationLine: "line-through", color: C.faint }]}>{t.title}</Text>
              <Text style={{ fontSize: 12, color: !t.doneAt && new Date(t.dueAt) < new Date() ? "#dc2626" : C.muted }}>{relDay(t.dueAt)}</Text>
            </Card>
          ))}
          <View style={[s.row, { marginTop: 4 }]}>
            <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="Add task (due tomorrow)" placeholderTextColor={C.faint} value={task} onChangeText={setTask} />
            <Btn title="Add" disabled={!task.trim()} onPress={() => run(async () => {
              await api(`/api/crm/leads/${id}/tasks`, { body: { title: task.trim(), type: "CALL", dueAt: new Date(Date.now() + 86400000).toISOString() } });
              setTask("");
            })} />
          </View>

          <Section title="Add a note" />
          <View style={s.row}>
            <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]} placeholder="What happened?" placeholderTextColor={C.faint} value={note} onChangeText={setNote} />
            <Btn kind="primary" title="Save" disabled={!note.trim()} onPress={() => run(async () => {
              await api(`/api/crm/leads/${id}/activities`, { body: { type: "NOTE", text: note.trim() } });
              setNote("");
            })} />
          </View>

          <Section title="Activity" />
          {c.activities.map((a: any) => (
            <View key={a.id} style={{ flexDirection: "row", gap: 10, marginBottom: 12 }}>
              <View style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: C.brandSoft, alignItems: "center", justifyContent: "center" }}>
                <Ionicons name={ICON[a.type] ?? "ellipse-outline"} size={15} color={C.brand} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.ink }}>{a.text}</Text>
                <Text style={[s.small, { fontSize: 11.5 }]}>{relDay(a.createdAt)} {fmtTime(a.createdAt)} · {a.actor}</Text>
              </View>
            </View>
          ))}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
