import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { getMeta, IMDB_RE, searchTitle, type TitleType } from "./cinemeta";
import { GitHubHandler } from "./github-handler";
import { saveSnapshot } from "./snapshot";
import { planAdd, planRemove, StremioClient, type AddPlan } from "./stremio";

export interface Props extends Record<string, unknown> {
  login: string;
  id: number;
}

const typeSchema = z.enum(["movie", "series"]);
const imdbSchema = z.string().regex(IMDB_RE, "IMDb id looks like tt1160419");

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

async function safe(fn: () => Promise<ReturnType<typeof text>>) {
  try {
    return await fn();
  } catch (e) {
    // Clear error to Claude; never echo secrets (none are ever part of error messages).
    return { isError: true as const, ...text(`Error: ${(e as Error).message}`) };
  }
}

export class MyMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "stremio-library", version: "0.1.0" });

  private stremio() {
    if (!this.env.STREMIO_AUTH_KEY) throw new Error("STREMIO_AUTH_KEY secret is not configured");
    return new StremioClient(this.env.STREMIO_AUTH_KEY);
  }

  /** Snapshot, then write exactly one item. Verifies the result afterwards. */
  private async write(client: StremioClient, plan: Exclude<AddPlan, { action: "noop" }>) {
    if (String(this.env.WRITES_ENABLED) !== "true") {
      throw new Error("Writes are disabled (WRITES_ENABLED != \"true\"). Use dry_run to preview the payload.");
    }
    const all = await client.getAll();
    const snapshot = await saveSnapshot(this.env.SNAPSHOTS, all);
    await client.put([plan.item]);
    const after = await client.getOne(plan.item._id);
    if (!after || after.removed !== plan.item.removed) {
      throw new Error(`Write sent but verification failed (snapshot ${snapshot} is available for recovery)`);
    }
    return snapshot;
  }

  async init() {
    const s = this.server;

    s.registerTool(
      "search_title",
      {
        description:
          "Search Cinemeta for movies/series. Returns candidates (imdb_id, name, year, type). If several match, show them to the user and let them choose; never guess.",
        inputSchema: {
          query: z.string().min(1).max(200),
          year: z.number().int().min(1870).max(2100).optional(),
          type: typeSchema.optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      ({ query, year, type }) =>
        safe(async () => {
          const c = await searchTitle(query, { year, type });
          return json(c.length ? { candidates: c } : { candidates: [], note: "No matches" });
        }),
    );

    s.registerTool(
      "list_library",
      {
        description: "List items in the Stremio library (removed items are hidden), optionally filtered by name.",
        inputSchema: {
          query: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      ({ query, limit }) =>
        safe(async () => {
          const all = (await this.stremio().getAll()).filter((i) => !i.removed);
          const q = query?.toLowerCase();
          const hits = all
            .filter((i) => !q || i.name.toLowerCase().includes(q))
            .sort((a, b) => b._mtime.localeCompare(a._mtime));
          return json({
            total_matches: hits.length,
            items: hits.slice(0, limit).map((i) => ({ imdb_id: i._id, name: i.name, type: i.type, modified: i._mtime })),
          });
        }),
    );

    s.registerTool(
      "add_to_library",
      {
        description:
          "Add a movie/series to the Stremio library by IMDb id (get it from search_title first). Idempotent; restores items previously removed. Use dry_run=true to preview the exact payload without writing.",
        inputSchema: { imdb_id: imdbSchema, type: typeSchema, dry_run: z.boolean().default(false) },
        annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
      },
      ({ imdb_id, type, dry_run }) =>
        safe(async () => {
          const client = this.stremio();
          const now = new Date();
          const existing = await client.getOne(imdb_id);
          if (existing && !existing.removed) return json({ status: "already_in_library", name: existing.name });
          const meta = await getMeta(imdb_id, type as TitleType);
          if (!meta) throw new Error(`Cinemeta has no ${type} with id ${imdb_id}`);
          let template = null;
          if (!existing) template = (await client.getAll()).find((i) => !i.removed) ?? null;
          const plan = planAdd(existing, meta, now, template);
          if (plan.action === "noop") return json({ status: "already_in_library" });
          if (dry_run) return json({ status: "dry_run", action: plan.action, payload: { changes: [plan.item] } });
          const snapshot = await this.write(client, plan);
          return json({ status: plan.action === "create" ? "added" : "restored", name: plan.item.name, snapshot });
        }),
    );

    s.registerTool(
      "remove_from_library",
      {
        description: "Mark an item as removed (removed=true) in the Stremio library. Nothing is hard-deleted.",
        inputSchema: { imdb_id: imdbSchema, dry_run: z.boolean().default(false) },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      ({ imdb_id, dry_run }) =>
        safe(async () => {
          const client = this.stremio();
          const plan = planRemove(await client.getOne(imdb_id), new Date());
          if (plan.action === "noop") return json({ status: "already_removed" });
          if (dry_run) return json({ status: "dry_run", payload: { changes: [plan.item] } });
          const snapshot = await this.write(client, plan);
          return json({ status: "removed", name: plan.item.name, snapshot });
        }),
    );
  }
}

// Defense in depth: even with a valid token, only ALLOWED_GITHUB_USER may reach the MCP agent.
const mcp = MyMCP.serve("/mcp");
const guardedMcp = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const props = (ctx as unknown as { props?: Props }).props;
    const allowed = env.ALLOWED_GITHUB_USER?.trim().toLowerCase();
    if (!allowed || !props?.login || props.login.toLowerCase() !== allowed) {
      return new Response("Forbidden", { status: 403 });
    }
    return mcp.fetch(request, env, ctx);
  },
};

// The provider needs the public URL for its RFC 9728 metadata, so build it lazily from env.
let provider: OAuthProvider<Env> | undefined;
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    provider ??= new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: guardedMcp as any,
      defaultHandler: GitHubHandler as any,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      resourceMetadata: {
        resource: `${env.PUBLIC_URL.replace(/\/$/, "")}/mcp`,
        authorization_servers: [env.PUBLIC_URL.replace(/\/$/, "")],
      },
    });
    return provider.fetch(request, env, ctx);
  },
};
