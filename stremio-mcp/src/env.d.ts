// Secrets (wrangler secret put) and provider helpers that `wrangler types` cannot know about.
interface ExtraEnv {
  STREMIO_AUTH_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}
declare namespace Cloudflare {
  interface Env extends ExtraEnv {}
}
interface Env extends ExtraEnv {}
