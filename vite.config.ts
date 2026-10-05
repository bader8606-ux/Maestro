import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const key =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (key) {
    let publicKey = key.startsWith("sb_publishable_");
    try {
      publicKey ||=
        JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString())
          .role === "anon";
    } catch {}
    if (!publicKey)
      throw new Error(
        "VITE_SUPABASE_PUBLISHABLE_KEY must be a public publishable/anon key. Never use a service-role or secret key in the frontend.",
      );
  }
  return {
    plugins: [react()],
    base: process.env.VITE_BASE_PATH || env.VITE_BASE_PATH || "/",
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": { target: "http://127.0.0.1:3000", changeOrigin: false },
      },
    },
  };
});
