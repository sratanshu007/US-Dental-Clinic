import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, ScrollView, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar, Btn, C, Card, Header, type IconName, Section, s } from "../../components/ui";
import { API_URL, api, fmtPhone } from "../../lib/api";
import { useAuth } from "../../lib/auth";

type Field = "aiEnabled" | "smsEnabled" | "noShowFollowUp" | "feedbackEnabled";

export default function More() {
  const { user, signOut } = useAuth();
  const [clinic, setClinic] = useState<any>(null);
  const isOwner = user?.role === "CLINIC_OWNER" || user?.role === "SUPER_ADMIN";

  const load = useCallback(async () => {
    try {
      setClinic((await api("/api/settings")).clinic);
    } catch { /* ignore */ }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function toggle(field: Field, value: boolean) {
    setClinic({ ...clinic, [field]: value });
    try {
      await api("/api/settings", { method: "PATCH", body: { [field]: value } });
    } catch (e: any) {
      Alert.alert("Could not save", e.message);
      load();
    }
  }

  const Row = ({ icon, label, hint, field, last }: { icon: IconName; label: string; hint: string; field: Field; last?: boolean }) => (
    <View style={[s.row, { paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: C.line, gap: 12 }]}>
      <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: C.brandSoft, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={icon} size={17} color={C.brand} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontWeight: "600", color: C.ink, fontSize: 15 }}>{label}</Text>
        <Text style={s.small}>{hint}</Text>
      </View>
      <Switch value={!!clinic?.[field]} disabled={!isOwner} onValueChange={(v) => toggle(field, v)} trackColor={{ true: C.brand }} />
    </View>
  );

  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}>
        <Header over={clinic?.name ?? "Clinic"} title="Settings" />
        <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Avatar name={user?.name ?? "?"} size={48} />
          <View style={{ flex: 1 }}>
            <Text style={s.name}>{user?.name}</Text>
            <Text style={s.small}>{user?.email}</Text>
            {!user?.totpEnabled && <Text style={{ fontSize: 12, color: "#dc2626", marginTop: 3 }}>Turn on 2-step login in the web dashboard</Text>}
          </View>
        </Card>

        <Section title="AI receptionist" />
        <Card style={{ paddingVertical: 2 }}>
          {clinic && <Text style={[s.small, { paddingTop: 10 }]}>AI phone line: {fmtPhone(clinic.aiPhoneNumber)}</Text>}
          <Row icon="sparkles-outline" label="Answer calls 24/7" hint="AI picks up every call" field="aiEnabled" />
          <Row icon="chatbubble-ellipses-outline" label="Text messages" hint="Confirmations and reminders" field="smsEnabled" />
          <Row icon="repeat-outline" label="No-show follow-up" hint="AI calls no-shows to rebook" field="noShowFollowUp" />
          <Row icon="star-outline" label="Feedback after visit" hint="AI asks how the visit went" field="feedbackEnabled" last />
        </Card>
        {!isOwner && <Text style={[s.small, { marginLeft: 2 }]}>Only the clinic owner can change these.</Text>}

        <View style={{ marginTop: 18 }}>
          <Btn icon="log-out-outline" title="Sign out" onPress={signOut} />
        </View>
        <Text style={[s.small, { textAlign: "center", marginTop: 16 }]}>
          Patients, calls, feedback and full settings are in the web dashboard.{"\n"}{API_URL.replace(/^https?:\/\//, "")}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
