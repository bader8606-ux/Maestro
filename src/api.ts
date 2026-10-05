import { createClient } from "@supabase/supabase-js";
const cloudUrl = import.meta.env.VITE_SUPABASE_URL;
const cloudKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const cloudMode = Boolean(cloudUrl && cloudKey);
export const connectionMissing =
  import.meta.env.VITE_HOSTING === "pages" && !cloudMode;
const cloud = cloudMode
  ? createClient(cloudUrl, cloudKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;
export const attachmentUrl = (
  a: { id: string; url?: string },
  download = false,
) => a.url || "/api/attachments/" + a.id + (download ? "?download=1" : "");
export async function request(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  const form = body instanceof FormData;
  const headers: Record<string, string> = {
    "X-Requested-With": "Maestro",
    ...(!form && body !== undefined
      ? { "Content-Type": "application/json" }
      : {}),
  };
  if (cloud) {
    const {
      data: { session },
      error,
    } = await cloud.auth.getSession();
    if (error) throw error;
    headers.apikey = cloudKey;
    if (session) headers.Authorization = "Bearer " + session.access_token;
  }
  return fetch(
    cloud ? cloudUrl + "/functions/v1/maestro-api" + url : "/api" + url,
    {
      method,
      headers,
      credentials: cloud ? "omit" : "same-origin",
      body: body === undefined ? undefined : form ? body : JSON.stringify(body),
    },
  );
}
export async function api<T>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (cloud && url === "/login") {
    const input = body as { email: string; password: string };
    const { error } = await cloud.auth.signInWithPassword(input);
    if (error) throw new Error(error.message);
    try {
      return await api<T>("/me");
    } catch (e) {
      await cloud.auth.signOut({ scope: "local" });
      throw e;
    }
  }
  if (cloud && url === "/logout") {
    const { error } = await cloud.auth.signOut({ scope: "local" });
    if (error) throw error;
    return { ok: true } as T;
  }
  const res = await request(url, method, body);
  if (!res.ok) {
    const err = await res.json().catch(() => ({
      error: "The workspace is unavailable. Please try again.",
    }));
    if (res.status === 401 && url !== "/login" && url !== "/me")
      window.dispatchEvent(new Event("session-expired"));
    throw new Error(err.error || "The request failed.");
  }
  return res.json();
}
