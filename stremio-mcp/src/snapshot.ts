import type { LibraryItem } from "./stremio";

const PREFIX = "snapshot:";
const KEEP = 10;
const MAX_BYTES = 24 * 1024 * 1024; // KV value limit is 25 MiB

/** Save the full library to KV, then prune to the newest KEEP snapshots. Throws if it cannot be saved. */
export async function saveSnapshot(kv: KVNamespace, items: LibraryItem[], now = new Date()): Promise<string> {
  const body = JSON.stringify({ takenAt: now.toISOString(), count: items.length, items });
  if (body.length > MAX_BYTES) throw new Error("Library too large to snapshot; refusing to write");
  const key = `${PREFIX}${now.toISOString()}`;
  await kv.put(key, body);
  const listed = await kv.list({ prefix: PREFIX });
  const keys = listed.keys.map((k) => k.name).sort(); // ISO timestamps sort chronologically
  for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) await kv.delete(old);
  return key;
}
