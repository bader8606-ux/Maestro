// Only public encryption material may leave this helper. The private key stays
// in the restricted settings table and is read only by the authorized workflow.
export async function publicImportKey(db, now = Date.now()) {
  const { data, error } = await db
    .from("maestro_settings")
    .select("data")
    .eq("id", "import-key")
    .maybeSingle();
  if (error || !data) return null;
  const key = data.data;
  const expiry = Date.parse(key?.expiresAt);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      key?.keyId || "",
    ) ||
    typeof key.publicKey !== "string" ||
    !/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\s*$/.test(
      key.publicKey,
    ) ||
    key.publicKey.length < 256 ||
    key.publicKey.length > 4096 ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    expiry > now + 2 * 60 * 60 * 1000 + 60 * 1000
  )
    return null;
  return {
    version: 1,
    algorithm: "RSA-OAEP-SHA256+A256GCM",
    keyId: key.keyId,
    publicKey: key.publicKey,
    expiresAt: key.expiresAt,
  };
}
