import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dental AI Receptionist",
  description: "AI receptionist dashboard for dental clinics",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
