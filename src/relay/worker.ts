import {
  OAuthProvider,
  OAuthError,
  AuthorizationError,
  CimdFetchError,
  type OAuthResourceContext,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { owner, sameOrigin } from "./owner-auth.js";
import { admin } from "./admin.js";
import { signedOwner } from "./admin-auth.js";
import { mcp } from "./mcp.js";
import {
  html,
  escapeHtml as e,
  form,
  scopeWarning,
  authorizationInstructions,
} from "../admin/page.js";
import {
  readBody,
  Fault,
  asOutcome,
  transportedFault,
  VERSION,
  PROTOCOL,
} from "../protocol/index.js";
export { SiyinRelay } from "./relay.js";

type Identity = { userId: string; grantId: string };
function createProvider(origin: string, verifyOwner: typeof owner) {
  return new OAuthProvider<Env>({
    resourceMetadata: {
      resource: origin + "/mcp",
      authorization_servers: [origin],
    },
    apiRoute: "/mcp",
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["runtime:approved"],
    requiredScopes: ["runtime:approved"],
    accessTokenTTL: 900,
    refreshTokenTTL: 2592000,
    async tokenExchangeCallback({
      env,
      grantType,
      grantId,
      clientId,
      userId,
      props,
    }) {
      if (userId !== "owner")
        throw new OAuthError("invalid_grant", {
          description: "Authorization revoked or expired",
        });
      const relay = env.RELAY.getByName("owner");
      const valid =
        grantType === "authorization_code"
          ? await relay.registerGrant(grantId, clientId)
          : await relay.checkGrant(grantId);
      if (!valid)
        throw new OAuthError("invalid_grant", {
          description: "Authorization revoked or expired",
        });
      return { newProps: { ...props, userId: "owner", grantId } };
    },
    apiHandler: {
      async fetch(request, env, ctx) {
        const identity = ctx as OAuthResourceContext<Identity>;
        if (identity.props?.userId !== "owner" || !identity.props.grantId)
          return new Response("Forbidden", { status: 403 });
        return mcp(
          request,
          env.RELAY.getByName("owner"),
          identity.props.grantId,
        );
      },
    },
    defaultHandler: {
      async fetch(request, env, ctx) {
        const path = new URL(request.url).pathname;
        const relay = env.RELAY.getByName("owner");
        if (
          [
            "/api/admin/authorization/inspect",
            "/api/admin/authorization/approve",
          ].includes(path)
        ) {
          await signedOwner(request, env, "oauth");
          if (request.method !== "POST")
            return new Response(null, { status: 405 });
          const p = z
            .strictObject({
              authorizationUrl: z.string().max(16384),
              clientId: z.string().optional(),
              redirectUri: z.string().optional(),
            })
            .parse(JSON.parse(await readBody(request)));
          const url = new URL(p.authorizationUrl);
          if (
            url.origin !== env.ORIGIN ||
            url.pathname !== "/authorize" ||
            url.username ||
            url.password ||
            url.hash
          )
            throw new Fault("invalid_authorization_request");
          const oauth = (env as Env & { OAUTH_PROVIDER: OAuthHelpers })
            .OAUTH_PROVIDER;
          const auth = await oauth.parseAuthRequest(new Request(url));
          const details = await oauth.describeConsent(auth);
          const headers = { "Cache-Control": "no-store" };
          if (path.endsWith("/inspect"))
            return Response.json(
              {
                ...details,
                accessTokenSeconds: 900,
                grantSeconds: 2592000,
                scope:
                  "All approved instances, including future owner-approved instances. Herdr executes as the local user.",
              },
              { headers },
            );
          if (
            p.clientId !== auth.clientId ||
            p.redirectUri !== auth.redirectUri
          )
            throw new Fault("permission_denied");
          return Response.json(
            await oauth.completeAuthorization({
              request: auth,
              userId: "owner",
              metadata: { consent: "owner-cli" },
              scope: ["runtime:approved"],
              props: { userId: "owner" },
            }),
            { headers },
          );
        }
        const managed = await admin(request, relay, env);
        if (managed) return managed;
        if (path === "/health" && request.method === "GET")
          return Response.json({
            service: "agenvo",
            version: VERSION,
            protocol: PROTOCOL,
            ownerConfigured: Boolean(
              env.OWNER_PUBLIC_KEY ||
              (env.ACCESS_AUD && env.ACCESS_ISSUER && env.OWNER_EMAIL),
            ),
          });
        if (path === "/connect" || path === "/disconnect")
          return relay.fetch(request);
        if (path === "/pairings" && request.method === "POST") {
          const result = await relay.createPairing(
            JSON.parse(await readBody(request)),
            request.headers.get("CF-Connecting-IP") ?? "local",
          );
          return Response.json(result, {
            status: 201,
            headers: { "Cache-Control": "no-store" },
          });
        }
        if (
          ["/pairings/poll", "/pairings/cancel"].includes(path) &&
          request.method === "POST"
        ) {
          const { code } = z
            .strictObject({ code: z.string().uuid() })
            .parse(JSON.parse(await readBody(request)));
          return Response.json(
            await (path === "/pairings/cancel"
              ? relay.cancelPairing(
                  code,
                  request.headers
                    .get("authorization")
                    ?.replace(/^Bearer /, "") ?? "",
                )
              : relay.pollPairing(
                  code,
                  request.headers
                    .get("authorization")
                    ?.replace(/^Bearer /, "") ?? "",
                )),
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        if (
          path !== "/authorize" &&
          path !== "/admin" &&
          !path.startsWith("/admin/")
        )
          return new Response(null, { status: 404 });
        if (
          path === "/authorize" &&
          request.method === "GET" &&
          verifyOwner === owner &&
          env.OWNER_PUBLIC_KEY &&
          !(env.ACCESS_ISSUER && env.ACCESS_AUD && env.OWNER_EMAIL)
        )
          return authorizationInstructions();
        await verifyOwner(request, env);
        const oauth = (env as Env & { OAUTH_PROVIDER: OAuthHelpers })
          .OAUTH_PROVIDER;
        if (path === "/authorize") {
          if (request.method === "GET") {
            const auth = await oauth.parseAuthRequest(request);
            const details = await oauth.describeConsent(auth);
            const consent = await oauth.beginConsent(auth);
            return html(
              "Authorize client / 授权客户端",
              `<p>Client / 客户端：<strong>${e(details.clientName)}</strong></p><p>Callback / 回调：${e(details.redirectHost)}</p>${scopeWarning}<p>Access tokens last 15 minutes; grants last up to 30 days and can be revoked. / 访问令牌 15 分钟，授权最长 30 天，可随时撤销。</p>${form("/authorize", { handle: consent.handle, decision: "approve" }, "Allow / 允许访问")}${form("/authorize", { handle: consent.handle, decision: "deny" }, "Deny / 拒绝")}`,
              consent.headers,
              new URL(details.redirectUri).origin,
            );
          }
          if (request.method !== "POST")
            return new Response(null, { status: 405 });
          sameOrigin(request, env);
          const data = await request.formData();
          const handle = String(data.get("handle"));
          if (data.get("decision") !== "approve") {
            const denied = await oauth.denyConsent(request, handle);
            return new Response(null, { status: 302, headers: denied.headers });
          }
          const approved = await oauth.approveConsent(request, handle, {
            scope: ["runtime:approved"],
          });
          const { redirectTo } = await oauth.completeAuthorization({
            request: approved.request,
            userId: "owner",
            metadata: {},
            scope: ["runtime:approved"],
            props: { userId: "owner" },
          });
          approved.headers.set("Location", redirectTo);
          return new Response(null, { status: 302, headers: approved.headers });
        }
        if (request.method === "POST") {
          sameOrigin(request, env);
          const data = Object.fromEntries(await request.formData());
          if (path === "/admin/pair") {
            const p = z
              .object({
                code: z.string().uuid(),
                digest: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .parse(data);
            await relay.approvePairing(p.code, p.digest);
          } else if (path === "/admin/instances") {
            const p = z
              .object({
                deviceId: z.string(),
                instanceId: z.string(),
                fingerprint: z.string(),
              })
              .parse(data);
            await relay.approveInstance(
              p.deviceId,
              p.instanceId,
              p.fingerprint,
            );
          } else if (path === "/admin/revoke") {
            const p = z
              .object({
                kind: z.enum(["device", "instance", "grant"]),
                id: z.string(),
                instanceId: z.string().optional(),
              })
              .parse(data);
            await relay.revoke(p.kind, p.id, p.instanceId);
            if (p.kind === "grant") {
              try {
                await oauth.revokeGrant(p.id, "owner");
              } catch {
                return html(
                  "Access revoked / 访问已撤销",
                  '<p>Access is blocked. Retry OAuth cleanup from the admin page. / 访问已禁止，可返回管理页重试 OAuth 清理。</p><a href="/admin">Back / 返回</a>',
                );
              }
            }
          } else return new Response(null, { status: 404 });
          return new Response(null, {
            status: 303,
            headers: { Location: "/admin" },
          });
        }
        if (request.method !== "GET")
          return new Response(null, { status: 405 });
        const state = JSON.parse(await relay.adminStateJson()) as ReturnType<
          import("./relay.js").SiyinRelay["adminState"]
        >;
        return html(
          "Agenvo administration / Agenvo 管理",
          `${scopeWarning}<p>MCP endpoint / 地址：<code>${e(env.ORIGIN)}/mcp</code></p><h2>Device pairing / 设备配对</h2>${
            state.pairings
              .filter((p) => !p.deviceId)
              .map(
                (p) =>
                  `<article><h3>${e(p.label)}</h3><p>Code / 请求码：${e(p.code)}</p><p>Compare the fingerprint with the device terminal / 请与设备终端核对指纹：</p><pre>${e(p.digest)}</pre><pre>${e(JSON.stringify(p.instances, null, 2))}</pre>${form("/admin/pair", { code: p.code, digest: p.digest }, "Approve device and listed instances / 批准设备与上述实例")}</article>`,
              )
              .join("") || "<p>No pending pairings. / 暂无配对请求。</p>"
          }<h2>Devices and instances / 设备与实例</h2>${state.devices.map((d) => `<article><h3>${e(d.label)} · ${d.revoked ? "Revoked / 已撤销" : d.online ? "Online / 在线" : "Offline / 离线"}</h3><small>${e(d.id)}</small>${!d.revoked ? form("/admin/revoke", { kind: "device", id: d.id }, "Revoke device / 撤销设备") : ""}${d.instances.map((i) => `<h4>${e(i.label)} · ${e(i.kind)} · ${i.approved ? "Approved / 已批准" : "Pending / 待批准"}</h4><pre>${e(JSON.stringify(i.scope, null, 2))}</pre><small>${e(i.fingerprint)}</small>${!d.revoked ? (i.approved ? form("/admin/revoke", { kind: "instance", id: d.id, instanceId: i.instanceId }, "Revoke instance / 撤销实例") : form("/admin/instances", { deviceId: d.id, instanceId: i.instanceId, fingerprint: i.fingerprint }, "Allow all authorized clients to access this instance / 允许所有有效客户端访问此实例")) : ""}`).join("")}</article>`).join("")}<h2>Client grants / 客户端授权</h2>${state.grants.map((g) => `<article><p>${e(g.clientId)}</p><p>${g.revoked ? "Revoked / 已撤销" : "Expires / 有效至 " + e(new Date(g.expires).toISOString())}</p>${form("/admin/revoke", { kind: "grant", id: g.id }, g.revoked ? "Retry OAuth cleanup / 重试 OAuth 清理" : "Revoke client / 撤销客户端")}</article>`).join("")}`,
        );
      },
    },
  });
}
export function createWorker(verifyOwner: typeof owner = owner) {
  let cached:
    { origin: string; provider: ReturnType<typeof createProvider> } | undefined;
  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ): Promise<Response> {
      try {
        if (new URL(request.url).origin !== env.ORIGIN)
          return new Response("Wrong host", { status: 421 });
        // Bound bodies before handing them to OAuth or MCP libraries.
        if (request.body)
          request = new Request(request, { body: await readBody(request) });
        if (!cached || cached.origin !== env.ORIGIN)
          cached = {
            origin: env.ORIGIN,
            provider: createProvider(env.ORIGIN, verifyOwner),
          };
        return await cached.provider.fetch(request, env, ctx);
      } catch (error) {
        error = transportedFault(error) ?? error;
        if (
          error instanceof AuthorizationError ||
          error instanceof CimdFetchError
        )
          return Response.json(
            { error: "invalid_authorization_request" },
            { status: 400 },
          );
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          return Response.json({ error: "invalid_request" }, { status: 400 });
        const status =
          error instanceof Fault
            ? ["permission_denied", "csrf_rejected"].includes(error.code)
              ? 403
              : error.code === "rate_limited"
                ? 429
                : error.code === "not_found"
                  ? 404
                  : error.code === "owner_not_configured"
                    ? 503
                    : 400
            : 503;
        return Response.json(asOutcome(error), { status });
      }
    },
  } satisfies ExportedHandler<Env>;
}
export default createWorker();
