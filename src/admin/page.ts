export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export function html(
  title: string,
  body: string,
  headers = new Headers(),
  redirectOrigin?: string,
) {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${redirectOrigin ? " " + redirectOrigin : ""}; frame-ancestors 'none'; base-uri 'none'`,
  );
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} · Siyin / 嗣音</title><style>body{font:16px/1.65 system-ui;margin:40px auto;max-width:900px;padding:0 24px;color:#263330;background:#f8faf8}h1,h2{line-height:1.3}article{background:white;border:1px solid #dbe3df;border-radius:12px;padding:20px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}button{padding:8px 14px;border:1px solid #93a69c;border-radius:6px;background:#e9f2ed;cursor:pointer}a{color:#236343}small{color:#52665e}</style><h1>${escapeHtml(title)}</h1>${body}</html>`,
    { headers },
  );
}
export function form(
  action: string,
  values: Record<string, unknown>,
  label: string,
) {
  return `<form method="post" action="${escapeHtml(action)}">${Object.entries(
    values,
  )
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`,
    )
    .join("")}<button>${escapeHtml(label)}</button></form>`;
}
export const scopeWarning =
  "<p>Authorization includes all approved instances and future approvals. Herdr runs commands as the local user; Codex limits apply only to its instance. Revocation does not stop existing tasks.</p><p>授权覆盖此部署中所有已批准实例，以及今后由你批准的实例。Herdr 可以用本机用户身份执行任意命令；Codex 的限制仅适用于对应实例。撤销访问不会终止已经开始的本地任务。</p>";

export function authorizationInstructions() {
  return html(
    "Owner approval / 所有者批准",
    `${scopeWarning}<p>Copy this authorization page URL and inspect it with the owner CLI. / 复制本授权页面地址，通过所有者 CLI 核对。</p><pre>siyin client inspect 'AUTHORIZATION_URL' --origin https://YOUR_RELAY</pre><p>Approve the exact client and callback shown by the CLI, then open redirectTo from its private output file. / 批准 CLI 显示的准确客户端与回调，然后打开私有输出文件中的 redirectTo。</p><pre>siyin client approve 'AUTHORIZATION_URL' --origin https://YOUR_RELAY --client-id ID --redirect-uri 'URI' --output PRIVATE_FILE</pre>`,
  );
}
