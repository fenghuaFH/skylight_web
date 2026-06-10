import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const SHARED = resolve(__dirname, "../shared/src");

// Generate SSL certs if HTTPS=1 and they don't exist yet
const certDir = resolve(__dirname, "../server/data");
const keyPath = resolve(certDir, "key.pem");
const certPath = resolve(certDir, "cert.pem");

if (process.env.HTTPS === "1" && (!existsSync(keyPath) || !existsSync(certPath))) {
  console.log("[vite] HTTPS=1 set but SSL certificates not found. Generating self-signed certificates...");
  try {
    if (!existsSync(certDir)) {
      mkdirSync(certDir, { recursive: true });
    }
    const cmd = `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -sha256 -days 365 -nodes -subj "/CN=localhost"`;
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    console.error("[vite] Failed to generate self-signed certificates:", err);
  }
}

const httpsConfig = process.env.HTTPS === "1" && existsSync(keyPath) && existsSync(certPath)
  ? {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    }
  : undefined;

const proto = process.env.HTTPS === "1" ? "https" : "http";
const SERVER = process.env.SERVER_URL ?? `${proto}://localhost:3000`;
const TRACKER = process.env.TRACKER_URL ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@shared": SHARED },
  },
  server: {
    host: true, // expose dev server on LAN too
    https: httpsConfig,
    fs: { allow: [resolve(__dirname, ".."), SHARED] },
    proxy: {
      // tracker first: more specific prefixes win over the bare /api below
      "/api/tracker": { target: TRACKER, changeOrigin: true },
      "/tracker-ws": { target: TRACKER, ws: true, changeOrigin: true },
      "/video": { target: TRACKER, changeOrigin: true },
      "/frame.jpg": { target: TRACKER, changeOrigin: true },
      "/api": { target: SERVER, changeOrigin: true, secure: false },
      "/ws": { target: SERVER, ws: true, changeOrigin: true, secure: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
      },
    },
  },
});
