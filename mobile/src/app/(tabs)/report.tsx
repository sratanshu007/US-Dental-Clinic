// Daily report: who came, who didn't, what the AI did.
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Avatar, C, Card, Chips, ErrorText, Header, IconBtn, Kpi, Loading, Ring, Section, s } from "../../components/ui";
import { addDays, api, fmtDate, fmtTime, patientName, todayISO } from "../../lib/api";

export default function Report() {
  const [date, setDate] = useState(todayISO());
  const [data, setData] = useState<any>(null);
  const [prov, setProv] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/reports/daily?date=${date}`));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [date]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const sm = data?.summary;
  const dentists = [...new Map((data?.appointments ?? []).filter((a: any) => a.provider).map((a: any) => [a.provider.id, a.provider.name])).entries()] as [string, string][];
  const appts = (data?.appointments ?? []).filter((a: any) => !prov || a.provider?.id === prov);
  const list = (st: string[]) => appts.filter((a: any) => st.includes(a.status));

  const Group = ({ title, rows, color }: { title: string; rows: any[]; color: string }) => (
    <>
      <Section title={`${title} (${rows.length})`} color={color} />
      {rows.length === 0 ? <Text style={[s.small, { marginLeft: 2 }]}>None</Text> : rows.map((a) => (
        <Card key={a.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12 }}>
          <Avatar name={patientName(a.patient)} size={36} />
          <View style={{ flex: 1 }}>
            <Text style={s.name}>{patientName(a.patient)}</Text>
            <Text style={s.small}>{fmtTime(a.startAt)} · {a.service?.name ?? a.reason ?? "Visit"}</Text>
          </View>
        </Card>
      ))}
    </>
  );

  return (
    <SafeAreaView style={s.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.brand} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}>
        <Header over="Daily report" title={date === todayISO() ? "Today" : fmtDate(`${date}T12:00:00`)}
          right={<View style={s.row}><IconBtn icon="chevron-back" onPress={() => setDate(addDays(date, -1))} /><IconBtn icon="chevron-forward" onPress={() => setDate(addDays(date, 1))} /></View>} />
        <ErrorText error={error} />
        {!sm ? <Loading /> : (
          <>
            <Card style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
              <Ring came={sm.showed} noShow={sm.noShow} />
              <View style={{ flex: 1 }}>
                <Text style={s.small}>Scheduled</Text>
                <Text style={{ fontSize: 28, fontWeight: "800", color: C.ink }}>{sm.scheduled}</Text>
                <Text style={{ fontSize: 12.5, color: "#16a34a" }}>● {sm.showed} came</Text>
                <Text style={{ fontSize: 12.5, color: "#dc2626" }}>● {sm.noShow} no-show</Text>
                {sm.unmarked > 0 && <Text style={{ fontSize: 12.5, color: C.muted }}>● {sm.unmarked} not marked</Text>}
              </View>
            </Card>
            <View style={[s.row, { marginBottom: 8 }]}>
              <Kpi icon="sparkles-outline" label="AI booked" value={sm.newBookingsByAi} />
              <Kpi icon="call-outline" label="Calls handled" value={sm.callsHandled} />
            </View>
            <View style={[s.row, { marginBottom: 6 }]}>
              <Kpi icon="person-add-outline" label="New inquiries" value={sm.newLeads} />
              <Kpi icon="star-outline" label="Avg rating" value={sm.avgRating ?? "—"} />
            </View>
            {dentists.length > 1 && (
              <View style={{ marginTop: 10 }}>
                <Chips value={prov} onChange={setProv} options={[["", "All dentists"], ...dentists]} />
              </View>
            )}
            <Group title="Came" rows={list(["SHOWED"])} color="#16a34a" />
            <Group title="No-show · AI will rebook" rows={list(["NO_SHOW"])} color="#dc2626" />
            <Group title="Not marked yet" rows={list(["BOOKED", "CONFIRMED"])} color={C.muted} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
