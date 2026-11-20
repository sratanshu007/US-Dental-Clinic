// Push notifications (new booking, new inquiry, daily report, low feedback).
// The server never puts patient names or health details in push text — lock screens show it.
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api } from "./api";

try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
} catch {
  // Expo Go on Android SDK 53+ or unsupported environment
}

export async function registerForPush(): Promise<string | null> {
  try {
    if (!Device.isDevice) return null; // simulators can't receive push

    if (Platform.OS === "android") {
      try {
        // Android 13+ only shows the permission prompt once a channel exists
        await Notifications.setNotificationChannelAsync("default", {
          name: "Clinic alerts",
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: "#0f766e",
        });
      } catch {
        // Ignored in Expo Go
      }
    }

    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (existing !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return null;

    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId || projectId.startsWith("REPLACE")) {
      return null;
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api("/auth/push-token", { body: { token, platform: Platform.OS } });
    return token;
  } catch {
    // Graceful degradation when push tokens are unavailable (e.g. Android Expo Go)
    return null;
  }
}
