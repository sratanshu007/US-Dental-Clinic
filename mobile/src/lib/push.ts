// Push notifications (new booking, new inquiry, daily report, low feedback).
// The server never puts patient names or health details in push text — lock screens show it.
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api } from "./api";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) return null; // simulators can't receive push

  if (Platform.OS === "android") {
    // Android 13+ only shows the permission prompt once a channel exists
    await Notifications.setNotificationChannelAsync("default", {
      name: "Clinic alerts",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#0f766e",
    });
  }

  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (existing !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return null;

  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId || projectId.startsWith("REPLACE")) {
    console.warn("Set extra.eas.projectId in app.json (run `npx eas-cli init`) to enable push.");
    return null;
  }
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await api("/auth/push-token", { body: { token, platform: Platform.OS } });
  return token;
}
