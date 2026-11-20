// Design system for the clinic app.
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import Svg, { Circle } from "react-native-svg";

export const C = {
  bg: "#f3f5f8",
  card: "#ffffff",
  ink: "#0d1520",
  text: "#33404d",
  muted: "#7a8794",
  faint: "#9aa5b1",
  line: "#e6eaef",
  brand: "#0f766e",
  brand2: "#14b8a6",
  brandSoft: "#e6f4f2",
  blue: "#2563eb",
  blueSoft: "#e8efff",
  green: "#15803d",
  greenSoft: "#e7f6ec",
  red: "#b42318",
  redSoft: "#fdecea",
  amber: "#b45309",
  amberSoft: "#fdf3e2",
  violet: "#6d28d9",
  violetSoft: "#f1ebff",
};
export const GRADIENT = ["#0f766e", "#0e9f8e", "#22c3ae"] as const;
export type IconName = keyof typeof Ionicons.glyphMap;

export const STATUS: Record<string, { bg: string; fg: string; label: string }> = {
  BOOKED: { bg: C.blueSoft, fg: C.blue, label: "Booked" },
  CONFIRMED: { bg: C.brandSoft, fg: C.brand, label: "Confirmed" },
  SHOWED: { bg: C.greenSoft, fg: C.green, label: "Came" },
  NO_SHOW: { bg: C.redSoft, fg: C.red, label: "No-show" },
  CANCELLED: { bg: C.amberSoft, fg: C.amber, label: "Cancelled" },
  RESCHEDULED: { bg: C.amberSoft, fg: C.amber, label: "Rescheduled" },
  NEW: { bg: C.blueSoft, fg: C.blue, label: "New inquiry" },
  CONTACTED: { bg: C.brandSoft, fg: C.brand, label: "Contacted" },
  APPT: { bg: C.violetSoft, fg: C.violet, label: "Appt booked" },
  PLAN: { bg: C.amberSoft, fg: C.amber, label: "Plan sent" },
  WON: { bg: C.greenSoft, fg: C.green, label: "Won" },
  LOST: { bg: C.redSoft, fg: C.red, label: "Lost" },
};

export function Pill({ value, label }: { value: string; label?: string }) {
  const b = STATUS[value] ?? { bg: "#eef1f4", fg: C.muted, label: value };
  return (
    <View style={[s.pill, { backgroundColor: b.bg }]}>
      <Text style={[s.pillText, { color: b.fg }]}>{label ?? b.label}</Text>
    </View>
  );
}

const AV = ["#0f766e", "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#0891b2", "#4d7c0f", "#b45309"];
export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const color = AV[[...name].reduce((t, c) => t + c.charCodeAt(0), 0) % AV.length];
  const ini = name.split(" ").filter(Boolean).map((x) => x[0]).join("").slice(0, 2).toUpperCase() || "?";
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: "#fff", fontWeight: "700", fontSize: size * 0.38 }}>{ini}</Text>
    </View>
  );
}

export function Card({ children, style, onPress }: { children: React.ReactNode; style?: ViewStyle; onPress?: () => void }) {
  if (onPress)
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [s.card, style, pressed && { opacity: 0.85 }]}>
        {children}
      </Pressable>
    );
  return <View style={[s.card, style]}>{children}</View>;
}

/** Big screen title with a small line above and the user's initials on the right. */
export function Header({ over, title, initials, dot, right }: { over: string; title: string; initials?: string; dot?: boolean; right?: React.ReactNode }) {
  return (
    <View style={s.header}>
      <View style={{ flex: 1 }}>
        <Text style={s.over}>{over}</Text>
        <Text style={s.title}>{title}</Text>
      </View>
      {right}
      {initials !== undefined && (
        <LinearGradient colors={[C.brand2, C.brand]} style={s.me}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>{initials}</Text>
          {dot && <View style={s.meDot} />}
        </LinearGradient>
      )}
    </View>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <View style={s.seg}>
      {options.map(([v, l]) => (
        <Pressable key={v} onPress={() => onChange(v)} style={[s.segBtn, value === v && s.segOn]}>
          <Text style={[s.segText, value === v && { color: C.ink }]}>{l}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Chips<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
      {options.map(([v, l]) => (
        <Pressable key={v} onPress={() => onChange(v)} style={[s.chip, value === v && s.chipOn]}>
          <Text style={[s.chipText, value === v && { color: "#fff" }]}>{l}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Btn({
  title, onPress, kind = "default", disabled, icon, style,
}: { title: string; onPress: () => void; kind?: "default" | "primary" | "green" | "red"; disabled?: boolean; icon?: IconName; style?: ViewStyle }) {
  const k = {
    default: { bg: "#fff", fg: C.ink, border: C.line },
    primary: { bg: C.brand, fg: "#fff", border: C.brand },
    green: { bg: C.greenSoft, fg: C.green, border: C.greenSoft },
    red: { bg: C.redSoft, fg: C.red, border: C.redSoft },
  }[kind];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.btn, { backgroundColor: k.bg, borderColor: k.border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }, style]}
    >
      {icon && <Ionicons name={icon} size={16} color={k.fg} />}
      <Text style={[s.btnText, { color: k.fg }]}>{title}</Text>
    </Pressable>
  );
}

export function IconBtn({ icon, onPress }: { icon: IconName; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.iconBtn, pressed && { opacity: 0.6 }]}>
      <Ionicons name={icon} size={20} color={C.ink} />
    </Pressable>
  );
}

export function Kpi({ label, value, icon, color }: { label: string; value: string | number; icon?: IconName; color?: string }) {
  return (
    <View style={s.kpi}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {icon && <Ionicons name={icon} size={13} color={C.muted} />}
        <Text style={s.kpiLabel}>{label}</Text>
      </View>
      <Text style={[s.kpiValue, color ? { color } : null]}>{value}</Text>
    </View>
  );
}

/** Donut: green = came, red = no-show, center = show rate. */
export function Ring({ came, noShow, size = 100 }: { came: number; noShow: number; size?: number }) {
  const r = size / 2 - 7, circ = 2 * Math.PI * r, total = came + noShow;
  const a = total ? came / total : 0, b = total ? noShow / total : 0;
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={C.line} strokeWidth={10} fill="none" />
        {a > 0 && <Circle cx={size / 2} cy={size / 2} r={r} stroke="#22c55e" strokeWidth={10} fill="none" strokeDasharray={`${a * circ} ${circ}`} strokeLinecap="round" rotation={-90} origin={`${size / 2}, ${size / 2}`} />}
        {b > 0 && <Circle cx={size / 2} cy={size / 2} r={r} stroke="#ef4444" strokeWidth={10} fill="none" strokeDasharray={`${b * circ} ${circ}`} strokeDashoffset={-a * circ} strokeLinecap="round" rotation={-90} origin={`${size / 2}, ${size / 2}`} />}
      </Svg>
      <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
        <Text style={{ fontSize: 20, fontWeight: "800", color: C.ink }}>{total ? Math.round(a * 100) : 0}%</Text>
        <Text style={{ fontSize: 10, color: C.muted }}>show rate</Text>
      </View>
    </View>
  );
}

export function Section({ title, color }: { title: string; color?: string }) {
  return <Text style={[s.section, color ? { color } : null]}>{title}</Text>;
}

export function Loading() {
  return (
    <View style={{ padding: 40 }}>
      <ActivityIndicator color={C.brand} />
    </View>
  );
}

export function Empty({ icon = "sparkles-outline", text }: { icon?: IconName; text: string }) {
  return (
    <View style={{ alignItems: "center", padding: 32, gap: 8 }}>
      <Ionicons name={icon} size={28} color={C.faint} />
      <Text style={{ color: C.faint, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <Text style={s.error}>{error}</Text> : null;
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  pad: { paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 6, paddingBottom: 14 },
  over: { fontSize: 13, color: C.muted, fontWeight: "500" },
  title: { fontSize: 26, fontWeight: "800", color: C.ink, letterSpacing: -0.4 },
  me: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  meDot: { position: "absolute", top: -1, right: -1, width: 12, height: 12, borderRadius: 6, backgroundColor: "#ef4444", borderWidth: 2, borderColor: C.bg },
  card: {
    backgroundColor: C.card, borderRadius: 18, padding: 14, marginBottom: 10,
    shadowColor: "#101828", shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2,
  },
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, alignSelf: "flex-start" },
  pillText: { fontSize: 11, fontWeight: "700" },
  seg: { flexDirection: "row", backgroundColor: "#e6eaef", borderRadius: 12, padding: 3, marginBottom: 12 },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: "center" },
  segOn: { backgroundColor: "#fff", shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  segText: { fontSize: 12.5, fontWeight: "700", color: C.muted },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99, borderWidth: 1, borderColor: C.line, backgroundColor: "#fff" },
  chipOn: { backgroundColor: C.ink, borderColor: C.ink },
  chipText: { fontSize: 12.5, fontWeight: "600", color: C.muted },
  btn: { flexDirection: "row", gap: 6, borderWidth: 1, borderRadius: 12, paddingVertical: 11, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
  btnText: { fontWeight: "700", fontSize: 14.5 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.line },
  kpi: { flex: 1, backgroundColor: "#fff", borderRadius: 16, padding: 12, shadowColor: "#101828", shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  kpiLabel: { fontSize: 11.5, color: C.muted, fontWeight: "600" },
  kpiValue: { fontSize: 22, fontWeight: "800", color: C.ink, marginTop: 2 },
  section: { fontSize: 12, fontWeight: "700", color: C.muted, textTransform: "uppercase", letterSpacing: 0.6, marginTop: 14, marginBottom: 8, marginLeft: 2 },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 13, fontSize: 16, backgroundColor: "#fff", color: C.ink, marginBottom: 12 },
  error: { backgroundColor: C.redSoft, color: C.red, padding: 10, borderRadius: 10, marginBottom: 10, marginHorizontal: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  small: { fontSize: 12.5, color: C.muted },
  name: { fontSize: 15.5, fontWeight: "700", color: C.ink },
});
