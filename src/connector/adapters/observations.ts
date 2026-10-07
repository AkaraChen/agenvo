import { createHash, randomUUID } from "node:crypto";
import { bytes, Fault, LIMITS } from "../../protocol/index.js";

type Observation = {
  sequence: number;
  observedAt: number;
  type: string;
  data: unknown;
  truncated?: boolean;
};

// One bounded journal per adapter. Cursors bind to a thread; evictions report a
// conservative gap even when the discarded events belonged to other threads.
export class Observations {
  private epoch = randomUUID();
  private sequence = 0;
  private entries: { scope: string; event: Observation }[] = [];
  private size = 0;
  constructor(
    private capacity = 512 * 1024,
    private count = 256,
  ) {}
  reset() {
    this.epoch = randomUUID();
    this.sequence = 0;
    this.entries = [];
    this.size = 0;
  }
  append(
    scope: string,
    type: string,
    data: unknown,
    summary: Record<string, unknown> = {},
  ) {
    const event: Observation = {
      sequence: ++this.sequence,
      observedAt: Date.now(),
      type,
      data,
    };
    if (bytes(event) > Math.min(this.capacity, 24 * 1024)) {
      event.data = { ...summary, omittedBytes: bytes(data) };
      event.truncated = true;
    }
    const entry = { scope, event };
    this.entries.push(entry);
    this.size += bytes(entry);
    while (this.entries.length > this.count || this.size > this.capacity)
      this.size -= bytes(this.entries.shift()!);
  }
  list(scope: string, cursor?: string, limit = 20) {
    const scopeId = createHash("sha256").update(scope).digest("hex");
    let after = 0,
      gap = false;
    if (cursor) {
      const match = /^([0-9a-f-]{36}):([0-9a-f]{64}):([0-9]+)$/.exec(cursor);
      if (
        !match ||
        match[2] !== scopeId ||
        !Number.isSafeInteger(Number(match[3]))
      )
        throw new Fault("invalid_cursor");
      gap = match[1] !== this.epoch;
      if (!gap) after = Number(match[3]);
      if (after > this.sequence) throw new Fault("invalid_cursor");
    }
    const first = this.entries[0]?.event.sequence ?? this.sequence + 1;
    gap ||= after < first - 1;
    const items: Observation[] = [];
    let size = 0,
      position = after;
    for (const { scope: target, event } of this.entries) {
      if (event.sequence <= after) continue;
      if (target === scope) {
        if (items.length >= limit || size + bytes(event) > LIMITS.frame / 2)
          break;
        items.push(event);
        size += bytes(event);
      }
      position = event.sequence;
    }
    if (!this.entries.length) position = this.sequence;
    return {
      items,
      nextCursor: `${this.epoch}:${scopeId}:${position}`,
      caughtUp: position === this.sequence,
      gap,
    };
  }
}
