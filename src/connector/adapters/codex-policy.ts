import { canonical, Fault } from "../../protocol/index.js";
import type { CodexConfig } from "../config.js";

// Native settings belong to the shared runtime, not to an attaching client.
export const sharedFields: Record<string, readonly string[]> = {
  "thread/resume": ["threadId", "excludeTurns", "initialTurnsPage"],
  "turn/start": [
    "threadId",
    "input",
    "model",
    "effort",
    "summary",
    "outputSchema",
  ],
  "thread/start": ["cwd", "model", "ephemeral", "historyMode"],
};

export function sandboxPolicy(config: CodexConfig) {
  return config.policy.sandbox === "read-only"
    ? { type: "readOnly", networkAccess: false }
    : {
        type: "workspaceWrite",
        writableRoots: [config.cwd],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      };
}
function deny(message: string): never {
  throw new Fault("policy_denied", message);
}
export function enforcePolicy(
  config: CodexConfig,
  method: string,
  original: Record<string, any>,
): Record<string, any> {
  const p = structuredClone(original);
  if (config.mode === "attach-unix") {
    // Shared threads retain their native settings. Attaching must not rewrite
    // a desktop-owned thread's cwd, instructions, or permission profile.
    const allowed = sharedFields[method];
    if (allowed && Object.keys(p).some((key) => !allowed.includes(key)))
      deny(
        "Shared Codex uses native settings; change permissions and thread settings in the owning app",
      );
    if (method === "thread/start") p.cwd ??= config.cwd;
    if ("limit" in p && (p.limit == null || p.limit > 50 || p.limit < 1))
      p.limit = 50;
    return p;
  }
  for (const [key, value] of Object.entries(p.config ?? {})) {
    if (
      !(config.policy.config[key] ?? []).some(
        (allowed) => canonical(allowed) === canonical(value),
      )
    )
      deny("Config override is not in the local allowlist: " + key);
  }
  if (
    p.modelProvider != null &&
    !config.policy.modelProviders.includes(p.modelProvider)
  )
    deny("Model provider is not approved locally");
  if (["thread/start", "thread/resume", "turn/start"].includes(method)) {
    if (p.cwd != null && p.cwd !== config.cwd)
      deny("Working directory differs from the approved instance");
    if (
      p.approvalPolicy != null &&
      p.approvalPolicy !== config.policy.approvalPolicy
    )
      deny("Approval policy differs from the local ceiling");
    if (p.approvalsReviewer != null && p.approvalsReviewer !== "user")
      deny("Approval must remain with the user");
    p.cwd = config.cwd;
    p.approvalPolicy = config.policy.approvalPolicy;
    p.approvalsReviewer = "user";
    if (method === "turn/start") {
      if (
        p.sandboxPolicy != null &&
        canonical(p.sandboxPolicy) !== canonical(sandboxPolicy(config))
      )
        deny("Sandbox policy differs from the local ceiling");
      p.sandboxPolicy = sandboxPolicy(config);
    } else {
      if (p.sandbox != null && p.sandbox !== config.policy.sandbox)
        deny("Sandbox differs from the local ceiling");
      p.sandbox = config.policy.sandbox;
    }
  }
  if ("limit" in p && (p.limit == null || p.limit > 50 || p.limit < 1))
    p.limit = 50;
  return p;
}
// Both the requested permissions and the local ceiling must contain every grant.
function subset(granted: any, requested: any): boolean {
  if (granted == null || granted === false) return true;
  if (Array.isArray(granted))
    return (
      Array.isArray(requested) &&
      granted.every((x) => requested.some((y) => canonical(x) === canonical(y)))
    );
  if (typeof granted === "object")
    return (
      requested &&
      typeof requested === "object" &&
      Object.entries(granted).every(([k, v]) => subset(v, requested[k]))
    );
  return granted === requested;
}
export function enforceApproval(
  config: CodexConfig,
  method: string,
  params: Record<string, any>,
  response: Record<string, any>,
) {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    const allowed = [
      "accept",
      "decline",
      "cancel",
      ...(config.policy.allowSessionApproval ? ["acceptForSession"] : []),
    ];
    if (
      typeof response.decision !== "string" ||
      !allowed.includes(response.decision)
    )
      deny("Persistent policy amendments are not permitted");
    if (
      params.availableDecisions &&
      !params.availableDecisions.includes(response.decision)
    )
      deny("Decision was not offered by the backend");
    if (
      config.mode !== "attach-unix" &&
      response.decision.startsWith("accept")
    ) {
      const ceiling =
        config.policy.sandbox === "workspace-write"
          ? { fileSystem: { write: [config.cwd] } }
          : {};
      if (
        method === "item/commandExecution/requestApproval" &&
        (params.cwd !== config.cwd ||
          params.environmentId != null ||
          params.networkApprovalContext != null ||
          params.additionalPermissions == null ||
          !subset(params.additionalPermissions, ceiling))
      )
        deny(
          "Command approval cannot prove the local sandbox ceiling; handle it locally",
        );
    }
    if (
      response.decision.startsWith("accept") &&
      method === "item/fileChange/requestApproval" &&
      params.grantRoot != null
    )
      deny("Persistent filesystem grants are not permitted");
    if (
      response.decision.startsWith("accept") &&
      config.mode !== "attach-unix" &&
      config.policy.sandbox === "read-only"
    )
      deny(
        "This instance cannot approve execution or file writes outside its read-only ceiling",
      );
  }
  if (method === "item/permissions/requestApproval") {
    if (
      (response.scope ?? "turn") !== "turn" &&
      !config.policy.allowSessionApproval
    )
      deny("Session permission grants are not enabled");
    if (response.strictAutoReview !== true)
      deny("Permission grants must retain strict auto review");
    const ceiling =
      config.policy.sandbox === "workspace-write"
        ? { fileSystem: { write: [config.cwd] } }
        : {};
    if (
      !subset(response.permissions, params.permissions) ||
      (config.mode !== "attach-unix" && !subset(response.permissions, ceiling))
    )
      deny("Permission grant exceeds the request or local ceiling");
  }
  if (method === "item/tool/requestUserInput") {
    const questions = params.questions ?? [];
    const keys = questions.map((q: any) => q.id);
    if (
      Object.keys(response.answers ?? {}).some((k) => !keys.includes(k)) ||
      keys.some((k: string) => !response.answers?.[k])
    )
      deny("Answers must match the pending questions");
  }
}
