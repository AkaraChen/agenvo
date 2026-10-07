import { connect, type Socket } from "node:net";
import type { RuntimeEvent } from "../../protocol/events.js";
import { bytes } from "../../protocol/index.js";

// Own only API subscriptions, never the native server. Lifecycle subscriptions
// remain open while the pane-specific status subscription is refreshed.
export class HerdrEvents {
  private sockets = new Set<Socket>();
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private status?: Socket;
  private refreshingEpoch?: number;
  private dirty = false;
  private epoch = 0;
  constructor(
    private path: string,
    private serviceId: string,
    private generation: string,
    private emit: (event: RuntimeEvent) => void,
  ) {}
  start() {
    if (this.stopped) return;
    const epoch = ++this.epoch;
    this.stream(
      [
        "pane.created",
        "pane.closed",
        "pane.exited",
        "pane.agent_detected",
        "pane.moved",
      ].map((type) => ({ type })),
      (packet) => {
        if (epoch !== this.epoch) return;
        if (packet.result?.type === "subscription_started") {
          void this.refresh(epoch);
          return;
        }
        if (typeof packet.event === "string") {
          this.publish(packet.event, packet.data ?? {});
          if (/created|closed|moved/.test(packet.event))
            void this.refresh(epoch);
        }
      },
      () => this.restart(epoch),
    );
  }
  private publish(nativeType: string, native: Record<string, unknown>) {
    const threadId =
      typeof native.pane_id === "string"
        ? native.pane_id
        : typeof (native.pane as any)?.pane_id === "string"
          ? (native.pane as any).pane_id
          : undefined;
    this.emit({
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      serviceId: this.serviceId,
      generation: this.generation,
      ...(threadId ? { threadId } : {}),
      nativeType,
      native:
        bytes(native) < 24000
          ? native
          : { omittedBytes: bytes(native), pane_id: threadId },
    });
  }
  private restart(epoch: number) {
    if (this.stopped || epoch !== this.epoch) return;
    this.epoch++;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.publish("agenvo.resync_required", {
      reason: "native_subscription_lost",
    });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.start(), 1000);
    this.retry.unref();
  }
  private async refresh(epoch: number) {
    if (this.stopped || epoch !== this.epoch) return;
    if (this.refreshingEpoch === epoch) {
      this.dirty = true;
      return;
    }
    this.refreshingEpoch = epoch;
    try {
      do {
        this.dirty = false;
        const result = await this.snapshot();
        if (this.stopped || epoch !== this.epoch) return;
        const panes = result.panes as Array<{ pane_id: string }>;
        if (!Array.isArray(panes) || panes.length > 512)
          throw new Error("invalid_pane_inventory");
        const old = this.status;
        if (!panes.length) {
          old?.destroy();
          this.status = undefined;
          continue;
        }
        await new Promise<void>((resolve, reject) => {
          const socket = this.stream(
            panes.map((p) => ({
              type: "pane.agent_status_changed",
              pane_id: p.pane_id,
            })),
            (packet) => {
              if (epoch !== this.epoch) return;
              if (packet.result?.type === "subscription_started") {
                old?.destroy();
                resolve();
                this.publish("agenvo.resync_required", {
                  reason: "native_subscription_ready",
                });
              } else if (typeof packet.event === "string")
                this.publish(packet.event, packet.data ?? {});
            },
            () => {
              reject(new Error("native_subscription_lost"));
              if (this.status === socket) this.restart(epoch);
            },
          );
          this.status = socket;
        });
      } while (this.dirty && !this.stopped);
    } catch {
      this.restart(epoch);
    } finally {
      if (this.refreshingEpoch === epoch) this.refreshingEpoch = undefined;
    }
  }
  private snapshot(): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const socket = this.open(
        { id: "inventory", method: "pane.list", params: {} },
        (packet) => {
          socket.destroy();
          if (packet.error) reject(new Error("native_inventory_failed"));
          else resolve(packet.result);
        },
        () => reject(new Error("native_inventory_failed")),
      );
    });
  }
  private stream(
    subscriptions: unknown[],
    receive: (packet: any) => void,
    failure: () => void,
  ) {
    return this.open(
      { id: "events", method: "events.subscribe", params: { subscriptions } },
      receive,
      failure,
      true,
    );
  }
  private open(
    request: unknown,
    receive: (packet: any) => void,
    failure: () => void,
    streaming = false,
  ) {
    const socket = connect(this.path);
    this.sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(8000, () => socket.destroy());
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (bytes(buffer) > 1024 * 1024) {
        socket.destroy();
        return;
      }
      let boundary;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        try {
          const packet = JSON.parse(line);
          if (packet.error) {
            socket.destroy();
            return;
          }
          if (streaming && packet.result?.type === "subscription_started")
            socket.setTimeout(0);
          receive(packet);
        } catch {
          socket.destroy();
          return;
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      failure();
    });
    return socket;
  }
  close() {
    this.stopped = true;
    this.epoch++;
    clearTimeout(this.retry);
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }
}
