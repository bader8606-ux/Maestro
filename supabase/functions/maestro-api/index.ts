import { createClient } from "@supabase/supabase-js";
import { createHandler } from "./handler.mjs";
const client = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);
Deno.serve(
  {
    port: Number(Deno.env.get("PORT") || 8000),
    hostname: Deno.env.get("HOST") || "0.0.0.0",
  },
  createHandler(client, {
    origins: (
      Deno.env.get("ALLOWED_ORIGINS") || "https://bader8606-ux.github.io"
    )
      .split(",")
      .map((s) => s.trim()),
  }),
);
