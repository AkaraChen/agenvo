import type { RuntimeEvent } from "../../protocol/events.js";
import { type InstanceConfig } from "../config.js";
import { bytes, LIMITS, page, type Outcome } from "../../protocol/index.js";
import type { AgentManagement } from "./management.js";
export type Method = {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
};
export interface Adapter {
  config: InstanceConfig;
  management: AgentManagement;
  version: string;
  available: boolean;
  onAvailabilityChange?: () => void;
  watchEvents?(emit: (event: RuntimeEvent) => void): () => void;
  methods(): Method[];
  call(method: string, params: Record<string, unknown>): Promise<Outcome>;
  close(): Promise<void>;
}
export function describe(adapter: Adapter, params: Record<string, unknown>) {
  const methods = adapter
    .methods()
    .filter((m) => !params.method || m.name === params.method);
  return {
    managementVersion: 1,
    management: {
      ...adapter.management.capabilities(),
      methods: adapter.management.methods().map((m) => m.name),
    },
    policy: {
      execution: "full-access",
      approvalPolicy: "never",
      authentication: "paired_devices_and_authorized_mcp_clients",
    },
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
