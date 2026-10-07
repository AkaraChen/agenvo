import { z } from "zod";
import { type AdminRelay } from "../relay/admin.js";
import { sameOrigin, logoutForm } from "./auth.js";
import { html, escapeHtml as e, form, scopeWarning } from "./page.js";
export async function managementPage(
  request: Request,
  relay: AdminRelay,
  origin: string,
  revokeOAuth?: (id: string) => Promise<void>,
) {
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
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const state = JSON.parse(await relay.adminStateJson()) as ReturnType<
    import("../relay/core.js").Relay["adminState"]
  >;
  return html(
    "Agenvo administration / Agenvo 管理",
    `${logoutForm()}${scopeWarning}<p>MCP endpoint / 地址：<code>${e(origin)}/mcp</code></p><h2>Device pairing / 设备配对</h2>${
      state.pairings
        .filter((p) => !p.deviceId)
        .map(
          (p) =>
            `<article><h3>${e(p.label)}</h3><p>Code / 请求码：${e(p.code)}</p><p>Compare the fingerprint with the device terminal / 请与设备终端核对指纹：</p><pre>${e(p.digest)}</pre><pre>${e(JSON.stringify(p.instances, null, 2))}</pre>${form("/admin/pair", { code: p.code, digest: p.digest }, "Approve device and listed instances / 批准设备与上述实例")}</article>`,
        )
        .join("") || "<p>No pending pairings. / 暂无配对请求。</p>"
    }<h2>Devices and instances / 设备与实例</h2>${state.devices.map((d) => `<article><h3>${e(d.label)} · ${d.revoked ? "Revoked / 已撤销" : d.online ? "Online / 在线" : "Offline / 离线"}</h3><small>${e(d.id)}</small>${!d.revoked ? form("/admin/revoke", { kind: "device", id: d.id }, "Revoke device / 撤销设备") : ""}${d.instances.map((i) => `<h4>${e(i.label)} · ${e(i.kind)} · ${i.approved ? "Approved / 已批准" : "Pending / 待批准"}</h4><pre>${e(JSON.stringify(i.scope, null, 2))}</pre><small>${e(i.fingerprint)}</small>${!d.revoked ? (i.approved ? form("/admin/revoke", { kind: "instance", id: d.id, instanceId: i.instanceId }, "Revoke instance / 撤销实例") : form("/admin/instances", { deviceId: d.id, instanceId: i.instanceId, fingerprint: i.fingerprint }, "Allow all authorized clients to access this instance / 允许所有有效客户端访问此实例")) : ""}`).join("")}</article>`).join("")}<h2>Client grants / 客户端授权</h2>${state.grants.map((g) => `<article><p>${e(g.clientId)}</p><p>${g.revoked ? "Revoked / 已撤销" : "Expires / 有效至 " + e(new Date(g.expires).toISOString())}</p>${form("/admin/revoke", { kind: "grant", id: g.id }, g.revoked ? "Retry OAuth cleanup / 重试 OAuth 清理" : "Revoke client / 撤销客户端")}</article>`).join("")}`,
  );
}
