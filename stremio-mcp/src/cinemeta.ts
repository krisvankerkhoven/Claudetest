// Read-only client for Stremio's public Cinemeta catalog (no auth needed).
const BASE = "https://v3-cinemeta.strem.io";

export type TitleType = "movie" | "series";

export interface Candidate {
  imdb_id: string;
  name: string;
  year: string | null;
  type: TitleType;
}

export interface Meta {
  imdb_id: string;
  name: string;
  type: TitleType;
  poster: string | null;
}

export const IMDB_RE = /^tt\d{5,10}$/;

async function getJson(url: string, fetchFn: typeof fetch): Promise<any> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cinemeta returned HTTP ${res.status}`);
  return res.json();
}

function yearOf(m: any): string | null {
  const raw = String(m.year ?? m.releaseInfo ?? "");
  return /^\d{4}/.test(raw) ? raw.slice(0, 4) : null;
}

export async function searchTitle(
  query: string,
  opts: { year?: number; type?: TitleType } = {},
  fetchFn: typeof fetch = fetch,
): Promise<Candidate[]> {
  const types: TitleType[] = opts.type ? [opts.type] : ["movie", "series"];
  const out: Candidate[] = [];
  for (const type of types) {
    const url = `${BASE}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
    const data = await getJson(url, fetchFn);
    for (const m of data?.metas ?? []) {
      const imdb_id = String(m.imdb_id ?? m.id ?? "");
      if (!IMDB_RE.test(imdb_id) || !m.name) continue;
      out.push({ imdb_id, name: String(m.name), year: yearOf(m), type });
    }
  }
  const filtered = opts.year ? out.filter((c) => c.year === String(opts.year)) : out;
  return filtered.slice(0, 15);
}

export async function getMeta(
  imdb_id: string,
  type: TitleType,
  fetchFn: typeof fetch = fetch,
): Promise<Meta | null> {
  const data = await getJson(`${BASE}/meta/${type}/${imdb_id}.json`, fetchFn);
  const m = data?.meta;
  if (!m?.name) return null;
  return { imdb_id, name: String(m.name), type, poster: m.poster ? String(m.poster) : null };
}
