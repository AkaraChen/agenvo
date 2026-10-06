import { type InstanceConfig } from "../config.js";
import { bytes, LIMITS, page, type Outcome } from "../../protocol/index.js";
export type Method = {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
};
export interface Adapter {
  config: InstanceConfig;
  version: string;
  available: boolean;
  onAvailabilityChange?: () => void;
  methods(): Method[];
  call(method: string, params: Record<string, unknown>): Promise<Outcome>;
  close(): Promise<void>;
}
export function describe(adapter: Adapter, params: Record<string, unknown>) {
  const methods = adapter
    .methods()
    .filter((m) => !params.method || m.name === params.method);
  return {
    policy:
      adapter.config.kind === "codex"
        ? adapter.config.mode === "attach-unix"
          ? {
              permissions: "native",
              scope:
                "Entire shared Codex home; thread settings remain owned by the native runtime",
              allowSessionApproval: adapter.config.policy.allowSessionApproval,
              lifecycle:
                "Disconnect only; never starts or stops the native server",
            }
          : adapter.config.policy
        : { shell: "arbitrary commands as the local OS user" },
    ...page(methods, params.cursor as string | undefined, 5),
  };
}
export function bounded(outcome: Outcome): Outcome {
  if (bytes(outcome) < LIMITS.frame - 2048) return outcome;
  return {
    execution: outcome.execution,
    nativeIds: outcome.nativeIds,
    error: {
      code: "result_too_large",
      message:
        "Native result exceeds 64 KiB. Use native IDs with narrower/paginated reads. Confirmation does not mean task completion.",
    },
  };
}
export function nativeIds(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return;
  const result = value as Record<string, any>;
  const ids: Record<string, string> = {};
  for (const key of ["thread", "turn", "workspace", "pane", "agent"]) {
    const object = result[key] ?? result.result?.[key];
    const id = object?.id ?? object?.[key + "_id"];
    if (typeof id === "string" && id.length <= 256) ids[key + "Id"] = id;
  }
  return Object.keys(ids).length ? ids : undefined;
}
export const accepted = (result: unknown): Outcome =>
  bounded({ execution: "accepted", result, nativeIds: nativeIds(result) });
