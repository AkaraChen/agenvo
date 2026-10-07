import { language, messages } from "./language.js";
import { z } from "zod";
import { type AdminRelay } from "../relay/admin.js";
import { sameOrigin } from "./auth.js";
import { html, escapeHtml as e, form, scopeWarning } from "./page.js";
export async function managementPage(
  request: Request,
  relay: AdminRelay,
  origin: string,
  revokeOAuth?: (id: string) => Promise<void>,
) {
  const locale = language(request);
  const text = messages(locale);
  const path = new URL(request.url).pathname;
  if (request.method === "POST") {
    sameOrigin(request, { ORIGIN: origin });
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
      await relay.approveInstance(p.deviceId, p.instanceId, p.fingerprint);
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
          await revokeOAuth?.(p.id);
        } catch {
          return html(
            locale,
            text.accessRevoked,
            `<p>${text.cleanupHelp}</p><a href="/admin">${text.back}</a>`,
          );
        }
      }
    } else return new Response(null, { status: 404 });
    return new Response(null, {
      status: 303,
      headers: { Location: "/admin" },
    });
  }
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const state = JSON.parse(await relay.adminStateJson()) as ReturnType<
    import("../relay/core.js").Relay["adminState"]
  >;
  return html(
    locale,
    text.adminTitle,
    `${form("/logout", {}, text.signOut)}${scopeWarning(locale)}<p>${text.mcpEndpoint}: <code>${e(origin)}/mcp</code></p><h2>${text.devicePairing}</h2>${
      state.pairings
        .filter((p) => !p.deviceId)
        .map(
          (p) =>
            `<article><h3>${e(p.label)}</h3><p>${text.code}: ${e(p.code)}</p><p>${text.compareFingerprint}</p><pre>${e(p.digest)}</pre><pre>${e(JSON.stringify(p.instances, null, 2))}</pre>${form("/admin/pair", { code: p.code, digest: p.digest }, text.approveDevice)}</article>`,
        )
        .join("") || `<p>${text.noPairings}</p>`
    }<h2>${text.devices}</h2>${state.devices.map((d) => `<article><h3>${e(d.label)} · ${d.revoked ? text.revoked : d.online ? text.online : text.offline}</h3><small>${e(d.id)}</small>${!d.revoked ? form("/admin/revoke", { kind: "device", id: d.id }, text.revokeDevice) : ""}${d.instances.map((i) => `<h4>${e(i.label)} · ${e(i.kind)} · ${i.approved ? text.approved : text.pending}</h4><pre>${e(JSON.stringify(i.scope, null, 2))}</pre><small>${e(i.fingerprint)}</small>${!d.revoked ? (i.approved ? form("/admin/revoke", { kind: "instance", id: d.id, instanceId: i.instanceId }, text.revokeInstance) : form("/admin/instances", { deviceId: d.id, instanceId: i.instanceId, fingerprint: i.fingerprint }, text.approveInstance)) : ""}`).join("")}</article>`).join("")}<h2>${text.grants}</h2>${state.grants.map((g) => `<article><p>${e(g.clientId)}</p><p>${g.revoked ? text.revoked : text.expires + ": " + e(new Date(g.expires).toLocaleString(locale, { timeZone: "UTC", timeZoneName: "short" }))}</p>${form("/admin/revoke", { kind: "grant", id: g.id }, g.revoked ? text.retryCleanup : text.revokeClient)}</article>`).join("")}`,
  );
}
