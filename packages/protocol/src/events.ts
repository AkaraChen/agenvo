import { z } from "zod";
import { identifier } from "./index.js";

export const eventFilter = z.strictObject({
  deviceId: identifier,
  instanceId: identifier,
  serviceId: z.string().min(1).max(128).optional(),
  threadId: z.string().min(1).max(256).optional(),
  nativeTypes: z.array(z.string().min(1).max(128)).min(1).max(32).optional(),
});
export const runtimeEvent = z.strictObject({
  eventId: z.string().uuid(),
  timestamp: z.string().datetime(),
  serviceId: z.string().max(128),
  threadId: z.string().max(256).optional(),
  generation: z.string().max(128).optional(),
  nativeType: z.string().min(1).max(128),
  native: z.record(z.string(), z.unknown()),
});
export type RuntimeEvent = z.infer<typeof runtimeEvent>;
export type EventFilter = z.infer<typeof eventFilter>;
const destination = z.strictObject({
  mode: z.literal("webhook"),
  url: z.url({ protocol: /^https$/ }).max(2048),
});
export const unsubscribeInput = z.strictObject({
  name: z.literal("runtime.changed"),
  arguments: eventFilter,
  delivery: destination,
});
export const subscribeInput = unsubscribeInput.extend({
  delivery: destination.extend({ secret: z.string().max(128) }),
  cursor: z.null().optional(),
  ttlMs: z.number().int().min(1000).nullable().optional(),
});
export const eventDefinition = {
  name: "runtime.changed",
  description:
    "Native runtime state, lifecycle and pending-input changes. Read current state/output to interpret them; idle is useful evidence, not proof of task success. Identity filters use native service/thread IDs from discovery. agenvo.resync_required bypasses nativeTypes/thread filters: rediscover after an observation interruption. No history replay or token deltas.",
  delivery: ["webhook"],
  inputSchema: z.toJSONSchema(eventFilter),
  payloadSchema: z.toJSONSchema(
    runtimeEvent
      .omit({ eventId: true, timestamp: true })
      .extend({ deviceId: identifier, instanceId: identifier }),
  ),
};
