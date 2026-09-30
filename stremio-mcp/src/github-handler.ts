// /authorize + /callback: per-client consent page, then GitHub sign-in. Only ALLOWED_GITHUB_USER gets a token.
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body: string, headers = new Headers(), status = 200) => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${body}`, {
    status,
    headers,
  });
};

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER;

  if (url.pathname === "/authorize" && request.method === "GET") {
    const req = await oauth.parseAuthRequest(request);
    const d = await oauth.describeConsent(req);
    const c = await oauth.beginConsent(req);
    return html(
      `<title>Authorize ${esc(d.clientName)}</title>
<h1>Allow ${esc(d.clientName)} to use your Stremio library?</h1>
<p>Access will be sent to <strong>${esc(d.redirectHost)}</strong>.${d.clientDomain ? ` Published by <strong>${esc(d.clientDomain)}</strong>.` : " This app registered itself; its name is not verified."}</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong></p>" : ""}
<form method="post"><input type="hidden" name="handle" value="${esc(c.handle)}">
<button name="decision" value="approve">Continue with GitHub</button> <button name="decision" value="deny">Deny</button></form>`,
      c.headers,
    );
  }

  if (url.pathname === "/authorize" && request.method === "POST") {
    const form = await request.formData();
    const handle = String(form.get("handle"));
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle);
    const { state, headers } = await oauth.beginUpstream(approved.request, { headers: approved.headers });
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    gh.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
    gh.searchParams.set("state", state);
    gh.searchParams.set("allow_signup", "false");
    // No scope: we only need the public identity (login) to check the allow-list.
    headers.set("Location", gh.href);
    return new Response(null, { status: 302, headers });
  }

  if (url.pathname === "/callback" && request.method === "GET") {
    const { request: original, headers } = await oauth.finishUpstream(request);
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") || !code) return html("<h1>GitHub sign-in was cancelled.</h1>", headers, 400);

    const tokRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: new URL("/callback", request.url).href,
      }),
    });
    const tok: any = await tokRes.json().catch(() => ({}));
    if (!tok.access_token) return html("<h1>GitHub sign-in failed.</h1>", headers, 400);

    const userRes = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": "stremio-mcp", accept: "application/vnd.github+json" },
    });
    const user: any = await userRes.json().catch(() => ({}));
    const allowed = env.ALLOWED_GITHUB_USER?.trim().toLowerCase();
    if (!allowed || !user?.login || String(user.login).toLowerCase() !== allowed) {
      console.warn("Rejected GitHub sign-in for a non-allowed user"); // no username logged
      return html("<h1>Access denied</h1>", headers, 403);
    }
    // The GitHub token is discarded on purpose; only login/id are stored in the grant props.
    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: String(user.id),
      metadata: { login: user.login },
      scope: original.scope,
      props: { login: user.login, id: user.id },
    });
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  }

  return new Response("Not found", { status: 404 });
}

export const GitHubHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (e) {
      if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
      if (e instanceof AuthorizationError) return html(`<h1>${esc(e.description ?? "Authorization failed")}</h1>`, new Headers(), 400);
      if (e instanceof CimdFetchError) return html("<h1>This app could not be verified.</h1>", new Headers(), 400);
      throw e;
    }
  },
};
