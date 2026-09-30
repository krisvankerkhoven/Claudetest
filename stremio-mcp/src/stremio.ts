// Client for Stremio's unofficial datastore API. Wire format follows
// Stremio/stremio-core (DatastoreRequest: authKey + collection + ids/all or changes).
import type { Meta, TitleType } from "./cinemeta";

const API = "https://api.strem.io/api";
const COLLECTION = "libraryItem";

export interface LibraryItem {
  _id: string;
  name: string;
  type: string;
  poster?: string | null;
  posterShape?: string;
  removed: boolean;
  temp: boolean;
  _ctime: string | null;
  _mtime: string;
  state: Record<string, unknown>;
  behaviorHints?: Record<string, unknown>;
  [k: string]: unknown;
}

export class StremioError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class StremioClient {
  constructor(
    private authKey: string,
    private fetchFn: typeof fetch = fetch,
    private delayMs = 400,
  ) {}

  private async call(method: string, body: Record<string, unknown>, retries: number): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetchFn(`${API}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ authKey: this.authKey, collection: COLLECTION, ...body }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status >= 500 && attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        const json: any = await res.json().catch(() => null);
        if (!res.ok || !json || json.error) {
          const msg = json?.error?.message ?? `HTTP ${res.status}`;
          // Never include the authKey in errors.
          throw new StremioError(`Stremio ${method} failed: ${msg}`);
        }
        return json.result;
      } catch (e) {
        if (e instanceof StremioError) throw e;
        if (attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new StremioError(`Stremio ${method} network error: ${(e as Error).message}`);
      }
    }
  }

  /** All library items, including removed ones. */
  async getAll(): Promise<LibraryItem[]> {
    const result = await this.call("datastoreGet", { ids: [], all: true }, 2);
    if (!Array.isArray(result)) throw new StremioError("Unexpected datastoreGet response shape");
    return result;
  }

  async getOne(id: string): Promise<LibraryItem | null> {
    const result = await this.call("datastoreGet", { ids: [id], all: false }, 2);
    if (!Array.isArray(result)) throw new StremioError("Unexpected datastoreGet response shape");
    return result.find((i: LibraryItem) => i._id === id) ?? null;
  }

  /** Writes exactly the given items; nothing else is sent. No retry: a write must not be repeated blindly. */
  async put(changes: LibraryItem[]): Promise<void> {
    if (changes.length !== 1) throw new StremioError("Refusing to write more than one item per call");
    await sleep(this.delayMs);
    const result = await this.call("datastorePut", { changes }, 0);
    if (result?.success === false) throw new StremioError("Stremio datastorePut reported success=false");
  }
}

const DEFAULT_STATE = {
  lastWatched: null,
  timeWatched: 0,
  timeOffset: 0,
  overallTimeWatched: 0,
  timesWatched: 0,
  flaggedWatched: 0,
  duration: 0,
  video_id: null,
  watched: null,
  noNotif: false,
};

/**
 * Build a new library item. If an existing item is supplied it is used as a shape
 * template: its keys are kept (with neutral values) so we match what Stremio itself writes.
 */
export function buildNewItem(meta: Meta, now: Date, template?: LibraryItem | null): LibraryItem {
  const iso = now.toISOString();
  const base: LibraryItem = {
    _id: meta.imdb_id,
    name: meta.name,
    type: meta.type,
    poster: meta.poster,
    posterShape: "poster",
    removed: false,
    temp: false,
    _ctime: iso,
    _mtime: iso,
    state: { ...DEFAULT_STATE },
    behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false },
  };
  if (!template) return base;
  const item: Record<string, unknown> = {};
  for (const k of Object.keys(template)) item[k] = k in base ? (base as any)[k] : null;
  for (const k of Object.keys(base)) if (!(k in item)) item[k] = (base as any)[k];
  const tState = (template.state ?? {}) as Record<string, unknown>;
  item.state = Object.fromEntries(
    Object.keys(tState).map((k) => [k, k in DEFAULT_STATE ? (DEFAULT_STATE as any)[k] : null]),
  );
  return item as LibraryItem;
}

export type AddPlan =
  | { action: "noop"; reason: string; item: LibraryItem }
  | { action: "restore" | "create"; item: LibraryItem };

/** Decide what to write. Pure, so it can be unit-tested and previewed as a dry run. */
export function planAdd(
  existing: LibraryItem | null,
  meta: Meta,
  now: Date,
  template?: LibraryItem | null,
): AddPlan {
  if (existing && !existing.removed) {
    return { action: "noop", reason: "Already in your library", item: existing };
  }
  if (existing) {
    return {
      action: "restore",
      item: { ...existing, removed: false, temp: false, _mtime: now.toISOString() },
    };
  }
  return { action: "create", item: buildNewItem(meta, now, template) };
}

export function planRemove(existing: LibraryItem | null, now: Date): AddPlan {
  if (!existing) throw new StremioError("Item is not in your library");
  if (existing.removed) return { action: "noop", reason: "Already removed", item: existing };
  return { action: "restore", item: { ...existing, removed: true, _mtime: now.toISOString() } };
}

export type { TitleType };
