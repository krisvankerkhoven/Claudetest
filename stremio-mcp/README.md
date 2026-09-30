# stremio-mcp

Remote MCP server (Cloudflare Workers, Streamable HTTP at `/mcp`) that lets Claude search Cinemeta and add movies/series to your Stremio library. Protected by GitHub OAuth (`@cloudflare/workers-oauth-provider`); only `ALLOWED_GITHUB_USER` can sign in.

Tools: `search_title`, `list_library`, `add_to_library` (idempotent, restores `removed` items, `dry_run` preview), `remove_from_library` (sets `removed=true`, never hard-deletes).

## Safety model
- Writes are **off** until `WRITES_ENABLED` is `"true"` in `wrangler.jsonc`. `dry_run=true` shows the exact payload.
- Before every write the full library is saved to KV (`SNAPSHOTS`, newest 10 kept). If the snapshot fails, nothing is written.
- Only one item is ever sent in `changes`; the client refuses more. After a write the item is re-read to verify.
- The Stremio authKey lives only as a Wrangler secret and is never included in errors or logs.
- Tokens are checked twice: OAuth token, then GitHub login must equal `ALLOWED_GITHUB_USER`. The GitHub token is discarded after login (no scopes requested).

## Setup
```sh
cd stremio-mcp && npm install
npx wrangler kv namespace create OAUTH_KV      # put the id in wrangler.jsonc
npx wrangler kv namespace create SNAPSHOTS     # put the id in wrangler.jsonc
```
Edit `wrangler.jsonc`: `ALLOWED_GITHUB_USER`, `PUBLIC_URL` (your final Worker URL, no trailing slash; deploy once to learn it, then redeploy).

Create a GitHub OAuth App (Settings > Developer settings > OAuth Apps): callback URL `<PUBLIC_URL>/callback`. Then:
```sh
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put STREMIO_AUTH_KEY
npx wrangler deploy
```
Local dev: copy `.dev.vars.example` to `.dev.vars` (git-ignored), `npx wrangler dev`, test with `npx @modelcontextprotocol/inspector` against `http://localhost:8787/mcp` (use a separate GitHub OAuth App with callback `http://localhost:8787/callback`).

## Add to claude.ai
Settings > Connectors > Add custom connector > URL `<PUBLIC_URL>/mcp`. Claude opens the consent page, then GitHub sign-in.

## Getting / rotating the Stremio authKey
- Get it: sign in at web.stremio.com, open DevTools > Console, run `JSON.parse(localStorage.getItem("profile")).auth.key`. Treat it like a password.
- Rotate: log out of Stremio everywhere (this invalidates the key), log in again, fetch the new key, `npx wrangler secret put STREMIO_AUTH_KEY`. No redeploy needed.
- Restore a snapshot: `npx wrangler kv key list --binding SNAPSHOTS`, then `kv key get`.

## Caveat
The Stremio API is unofficial. The request/response shapes were checked against `Stremio/stremio-core` source, but not against the live API (the build sandbox could not reach `api.strem.io`). `add_to_library` copies the key shape of an existing library item as a template; run `dry_run` first and compare.
