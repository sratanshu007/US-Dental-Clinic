import type { NextConfig } from "next";

// Security headers for every page.
const api = process.env.NEXT_PUBLIC_API_URL ?? "";
const isDev = process.env.NODE_ENV !== "production";
const csp = [
  "default-src 'self'",
  // Next.js needs inline bootstrap scripts; eval only in development (hot reload)
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${api} https: http:${isDev ? " ws: http://localhost:*" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  async rewrites() {
    const backend = process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_API_URL;
    if (!backend) return [];
    let base = backend.trim().replace(/\/$/, "");
    if (!base.startsWith("http://") && !base.startsWith("https://")) {
      base = base.includes(".") ? `https://${base}` : `http://${base}:10000`;
    }
    return [
      { source: "/api/:path*", destination: `${base}/api/:path*` },
      { source: "/auth/:path*", destination: `${base}/auth/:path*` },
    ];
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      ],
    }];
  },
};

export default nextConfig;
