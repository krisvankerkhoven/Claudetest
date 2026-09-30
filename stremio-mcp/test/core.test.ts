import { describe, expect, it, vi } from "vitest";
import { searchTitle, getMeta } from "../src/cinemeta";
import { buildNewItem, planAdd, planRemove, StremioClient, type LibraryItem } from "../src/stremio";
import { saveSnapshot } from "../src/snapshot";

const meta = { imdb_id: "tt15239678", name: "Dune: Part Two", type: "movie" as const, poster: "https://x/p.jpg" };
const now = new Date("2026-01-01T00:00:00Z");
const existing = (o: Partial<LibraryItem> = {}): LibraryItem => ({
  ...buildNewItem(meta, new Date("2025-01-01T00:00:00Z")),
  ...o,
});
const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("planAdd", () => {
  it("creates a new item with expected shape", () => {
    const p = planAdd(null, meta, now);
    expect(p.action).toBe("create");
    expect(p.item).toMatchObject({ _id: "tt15239678", removed: false, temp: false, _ctime: now.toISOString() });
  });
  it("is a no-op when already present", () => {
    expect(planAdd(existing(), meta, now).action).toBe("noop");
  });
  it("restores a removed item, keeping its other fields", () => {
    const old = existing({ removed: true, state: { timesWatched: 3 } });
    const p = planAdd(old, meta, now);
    expect(p.action).toBe("restore");
    expect(p.item).toMatchObject({ removed: false, _mtime: now.toISOString(), state: { timesWatched: 3 } });
  });
  it("copies key shape from a template but resets watch state", () => {
    const tpl = { ...existing(), extraKey: 1, state: { timesWatched: 9, customField: 5 } } as LibraryItem;
    const item = buildNewItem(meta, now, tpl);
    expect(Object.keys(item)).toEqual(expect.arrayContaining(Object.keys(tpl)));
    expect(item.name).toBe("Dune: Part Two");
    expect(item.state).toEqual({ timesWatched: 0, customField: null });
  });
});

describe("planRemove", () => {
  it("marks removed", () => expect(planRemove(existing(), now).item.removed).toBe(true));
  it("errors when missing", () => expect(() => planRemove(null, now)).toThrow());
});

describe("StremioClient", () => {
  it("sends only the single changed item and never leaks the key in errors", async () => {
    const f = vi.fn(async () => jsonRes({ result: { success: true } }));
    const c = new StremioClient("SECRETKEY", f as any, 0);
    await c.put([existing()]);
    const body = JSON.parse((f.mock.calls[0] as any)[1].body);
    expect(body.collection).toBe("libraryItem");
    expect(body.changes).toHaveLength(1);
    const bad = new StremioClient("SECRETKEY", (async () => jsonRes({ error: { message: "Session does not exist" } }, 200)) as any, 0);
    await expect(bad.getAll()).rejects.toThrow(/Session does not exist/);
    await expect(bad.getAll()).rejects.not.toThrow(/SECRETKEY/);
  });
  it("refuses multi-item writes", async () => {
    await expect(new StremioClient("k", vi.fn() as any, 0).put([existing(), existing()])).rejects.toThrow();
  });
});

describe("snapshots", () => {
  it("keeps only the newest 10", async () => {
    const store = new Map<string, string>();
    const kv = {
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
    } as unknown as KVNamespace;
    for (let i = 0; i < 13; i++) await saveSnapshot(kv, [existing()], new Date(2026, 0, 1, 0, i));
    expect(store.size).toBe(10);
    expect([...store.keys()].sort()[0]).toContain("T00:03");
  });
});

describe("cinemeta", () => {
  it("returns candidates, filters by year, skips bad ids", async () => {
    const f = vi.fn(async () =>
      jsonRes({ metas: [{ imdb_id: "tt15239678", name: "Dune: Part Two", releaseInfo: "2024" }, { imdb_id: "tt0087182", name: "Dune", year: "1984" }, { id: "bogus", name: "x" }] }),
    );
    const all = await searchTitle("dune", { type: "movie" }, f as any);
    expect(all).toHaveLength(2);
    const y = await searchTitle("dune", { type: "movie", year: 2024 }, f as any);
    expect(y.map((c) => c.imdb_id)).toEqual(["tt15239678"]);
  });
  it("getMeta returns null on 404", async () => {
    expect(await getMeta("tt0000001", "movie", (async () => new Response("", { status: 404 })) as any)).toBeNull();
  });
});
