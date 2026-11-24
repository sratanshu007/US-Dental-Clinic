import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Redirect } from "expo-router";
import Constants from "expo-constants";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Btn, C, ErrorText, GRADIENT, s } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { user, ready, signIn } = useAuth();
  const extra = (Constants.expoConfig?.extra || {}) as Record<string, string>;
  const [email, setEmail] = useState(extra.adminEmail || "admin@deificdigital.com");
  const [password, setPassword] = useState(extra.adminPassword || "ChangeMe-Admin-2026");
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (ready && user) return <Redirect href="/" />;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (!mfaToken) {
        const r = await api("/auth/login", { body: { email: email.trim(), password } });
        if (r.mfaRequired) setMfaToken(r.mfaToken);
        else await signIn(r);
      } else {
        await signIn(await api("/auth/mfa/verify", { body: { mfaToken, code } }));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.screen}>
      <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ paddingBottom: 60 }}>
        <SafeAreaView edges={["top"]} style={{ paddingHorizontal: 24, paddingTop: 30 }}>
          <View style={{ width: 54, height: 54, borderRadius: 16, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" }}>
            <Ionicons name="call" size={26} color="#fff" />
          </View>
          <Text style={{ color: "#fff", fontSize: 30, fontWeight: "800", marginTop: 18 }}>Clinic AI Desk</Text>
          <Text style={{ color: "rgba(255,255,255,0.85)", fontSize: 15, marginTop: 4 }}>Your AI receptionist, in your pocket.</Text>
        </SafeAreaView>
      </LinearGradient>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, marginTop: -36 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16 }} keyboardShouldPersistTaps="handled">
          <View style={{ backgroundColor: "#fff", borderRadius: 24, padding: 20, shadowColor: "#101828", shadowOpacity: 0.08, shadowRadius: 20, elevation: 4 }}>
            <Text style={{ fontSize: 20, fontWeight: "800", color: C.ink, marginBottom: 14 }}>{mfaToken ? "Two-step verification" : "Sign in"}</Text>
            {error && <View style={{ marginHorizontal: -16 }}><ErrorText error={error} /></View>}
            {!mfaToken ? (
              <>
                <TextInput style={s.input} placeholder="Email" autoCapitalize="none" keyboardType="email-address" autoComplete="email" value={email} onChangeText={setEmail} placeholderTextColor={C.faint} />
                <TextInput style={s.input} placeholder="Password" secureTextEntry autoComplete="password" value={password} onChangeText={setPassword} placeholderTextColor={C.faint} />
              </>
            ) : (
              <>
                <Text style={[s.small, { marginBottom: 8 }]}>Enter the 6-digit code from your authenticator app</Text>
                <TextInput style={[s.input, { fontSize: 24, letterSpacing: 8, textAlign: "center" }]} placeholder="••••••" keyboardType="number-pad" maxLength={6} autoComplete="one-time-code" value={code} onChangeText={setCode} autoFocus placeholderTextColor={C.faint} />
              </>
            )}
            <Btn kind="primary" title={busy ? "Please wait…" : mfaToken ? "Verify" : "Sign in"} onPress={submit} disabled={busy || (!mfaToken ? !email || !password : code.length !== 6)} />
          </View>
          <View style={[s.row, { justifyContent: "center", marginTop: 18 }]}>
            <Ionicons name="lock-closed-outline" size={13} color={C.faint} />
            <Text style={[s.small, { fontSize: 12 }]}>Protected health information. Access is logged.</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
