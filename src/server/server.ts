import express from "express";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFile, mkdir, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { Relay, type RelaySocket } from "../relay/core.js";
import { mcp } from "../relay/mcp.js";
import { signedOwner } from "../relay/admin-auth.js";
import {
  LIMITS,
  PROTOCOL,
  VERSION,
  Fault,
  asOutcome,
} from "../protocol/index.js";
import { SqliteStore } from "./store.js";
import { VpsOAuth } from "./oauth.js";

export const serverConfig = z.strictObject({
  origin: z
    .string()
    .url()
    .refine((s) => {
      const u = new URL(s);
      return u.protocol === "https:" && u.origin === s;
    }),
  ownerPublicKey: z.string().transform((s) => {
    const k = JSON.parse(s);
    if (k.kty !== "EC" || k.crv !== "P-256" || k.d || !k.x || !k.y)
      throw new Error("Invalid owner public key");
    return s;
  }),
  dataDir: z.string().startsWith("/"),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(8080),
  tls: z.strictObject({ cert: z.string(), key: z.string() }).optional(),
});
export type ServerConfig = z.infer<typeof serverConfig>;
class Socket implements RelaySocket {
  private attachment!: ReturnType<RelaySocket["deserializeAttachment"]>;
  constructor(readonly ws: WebSocket) {}
  get readyState() {
    return this.ws.readyState;
  }
  send(value: string) {
    this.ws.send(value);
  }
  close(code: number, reason: string) {
    this.ws.close(code, reason);
  }
  serializeAttachment(value: typeof this.attachment) {
    this.attachment = value;
  }
  deserializeAttachment() {
    return this.attachment;
  }
}
export async function startServer(input: ServerConfig) {
  const config = serverConfig.parse(input);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const info = await lstat(config.dataDir);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Fault(
      "insecure_data_directory",
      "The data directory must be owned by this user with mode 0700",
    );
  const dbPath = join(config.dataDir, "siyin.sqlite");
  try {
    const file = await open(dbPath, "wx", 0o600);
    await file.close();
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
  }
  const dbInfo = await lstat(dbPath);
  if (
    !dbInfo.isFile() ||
    dbInfo.uid !== process.getuid?.() ||
    (dbInfo.mode & 0o077) !== 0
  )
    throw new Fault("insecure_database");
  const tls = config.tls
    ? {
        cert: await readFile(config.tls.cert),
        key: await readFile(config.tls.key),
      }
    : undefined;
  const store = new SqliteStore(dbPath);
  const connections = new Map<string, Set<Socket>>();
  const relay = new Relay({
    origin: config.origin,
    store,
    sockets: (id) => [...(connections.get(id) ?? [])],
    accept: (ws, id) => {
      const set = connections.get(id) ?? new Set<Socket>();
      set.add(ws as Socket);
      connections.set(id, set);
    },
    scheduleCleanup: async () => {},
  });
  const oauth = new VpsOAuth(store, relay, config.origin);
  const cleanup = setInterval(() => {
    relay.alarm();
    oauth.cleanup();
  }, 60000);
  cleanup.unref();
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(config.origin).host) {
      res.status(421).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl: new URL(config.origin),
      resourceServerUrl: new URL(config.origin + "/mcp"),
      scopesSupported: ["runtime:approved"],
    }),
  );
  // Keep bytes intact for signed administrator requests; never reconstruct JSON.
  app.use(express.raw({ type: () => true, limit: LIMITS.parse }));
  app.use(async (req, res) => {
    const body: Buffer = req.body ?? Buffer.alloc(0);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const request = new Request(config.origin + req.originalUrl, {
      method: req.method,
      headers,
      ...(body.length ? { body: new Uint8Array(body) } : {}),
    });
    const path = new URL(request.url).pathname;
    const json = () => JSON.parse(body.toString("utf8"));
    let response: Response;
    try {
      if (path === "/health" && req.method === "GET")
        response = Response.json({
          service: "siyin",
          version: VERSION,
          protocol: PROTOCOL,
          ownerConfigured: true,
          deployment: "vps",
        });
      else if (path === "/mcp") {
        let grantId: string | undefined;
        try {
          const auth = await oauth.verifyAccessToken(
            headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
          );
          grantId = String(auth.extra!.grantId);
        } catch {
          /* Invalid or revoked tokens receive the OAuth challenge below. */
        }
        response = grantId
          ? await mcp(request, relay, grantId)
          : new Response(null, {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp"`,
              },
            });
      } else if (path === "/pairings" && req.method === "POST")
        response = Response.json(
          await relay.createPairing(
            json(),
            req.socket.remoteAddress ?? "unknown",
          ),
          { status: 201 },
        );
      else if (
        ["/pairings/poll", "/pairings/cancel"].includes(path) &&
        req.method === "POST"
      ) {
        const p = z.strictObject({ code: z.string().uuid() }).parse(json());
        const secret =
          headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        response = Response.json(
          await (path.endsWith("poll")
            ? relay.pollPairing(p.code, secret)
            : relay.cancelPairing(p.code, secret)),
        );
      } else if (path === "/disconnect" && req.method === "POST") {
        const id = headers.get("siyin-device-id") ?? "";
        if (
          !(await relay.authenticateDevice(
            id,
            headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
          ))
        )
          throw new Fault("permission_denied");
        response = Response.json(relay.revoke("device", id));
      } else if (path.startsWith("/api/admin/")) {
        await signedOwner(
          request,
          { ORIGIN: config.origin, OWNER_PUBLIC_KEY: config.ownerPublicKey },
          path.startsWith("/api/admin/authorization/") ? "oauth" : "pairing",
        );
        if (path === "/api/admin/pairings" && req.method === "GET")
          response = Response.json({
            pairings: relay.adminState().pairings.filter((p) => !p.deviceId),
          });
        else if (path === "/api/admin/state" && req.method === "GET")
          response = Response.json(relay.adminState());
        else if (req.method !== "POST")
          response = new Response(null, { status: 405 });
        else if (path === "/api/admin/pairings/approve") {
          const p = z
            .strictObject({
              code: z.string().uuid(),
              digest: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .parse(json());
          response = Response.json(relay.approvePairing(p.code, p.digest));
        } else if (path === "/api/admin/instances/approve") {
          const p = z
            .strictObject({
              deviceId: z.string(),
              instanceId: z.string(),
              fingerprint: z.string(),
            })
            .parse(json());
          response = Response.json(
            relay.approveInstance(p.deviceId, p.instanceId, p.fingerprint),
          );
        } else if (path === "/api/admin/revoke") {
          const p = z
            .strictObject({
              kind: z.enum(["device", "instance", "grant"]),
              id: z.string(),
              instanceId: z.string().optional(),
            })
            .parse(json());
          response = Response.json(relay.revoke(p.kind, p.id, p.instanceId));
        } else if (
          [
            "/api/admin/authorization/inspect",
            "/api/admin/authorization/approve",
          ].includes(path)
        ) {
          const p = z
            .strictObject({
              authorizationUrl: z.string().max(16384),
              clientId: z.string().optional(),
              redirectUri: z.string().optional(),
            })
            .parse(json());
          const { params: _, ...details } = oauth.inspect(p.authorizationUrl);
          response = Response.json(
            path.endsWith("inspect")
              ? { ...details, accessTokenSeconds: 900, grantSeconds: 2592000 }
              : oauth.approve(
                  p.authorizationUrl,
                  p.clientId ?? "",
                  p.redirectUri ?? "",
                ),
          );
        } else response = new Response(null, { status: 404 });
      } else if (path === "/admin" || path === "/admin/pair")
        response = new Response(
          "Use the owner's signed CLI for pairing, consent and revocation. / 请使用所有者签名 CLI 管理配对、授权和撤销。",
          { headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      else response = new Response(null, { status: 404 });
    } catch (error) {
      const status =
        error instanceof Fault
          ? error.code === "permission_denied"
            ? 403
            : error.code === "rate_limited"
              ? 429
              : 400
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 503;
      response = Response.json(
        error instanceof Fault
          ? asOutcome(error)
          : { error: "invalid_request" },
        { status },
      );
    }
    res.status(response.status);
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.send(Buffer.from(await response.arrayBuffer()));
  });
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status((error as { status?: number }).status === 413 ? 413 : 500)
        .json({ error: "request_failed" });
    },
  );
  const server = tls ? httpsServer(tls, app) : httpServer(app);
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.parse,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    const reject = () => {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    };
    void (async () => {
      if (
        req.headers.host !== new URL(config.origin).host ||
        req.url !== "/connect" ||
        req.headers["siyin-protocol"] !== String(PROTOCOL)
      ) {
        reject();
        return;
      }
      const id = String(req.headers["siyin-device-id"] ?? "");
      if (
        !(await relay.authenticateDevice(
          id,
          String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
        ))
      ) {
        reject();
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        const peer = new Socket(ws);
        try {
          relay.connect(id, peer);
        } catch {
          ws.close(1008, "unauthorized");
          return;
        }
        ws.on("message", (data, binary) => {
          if (!binary && data.toString() === "siyin:ping") {
            peer.send("siyin:pong");
            return;
          }
          relay.webSocketMessage(
            peer,
            binary ? new ArrayBuffer(0) : data.toString(),
          );
        });
        ws.on("close", (code, reason) => {
          relay.webSocketClose(peer, code, reason.toString());
          connections.get(id)?.delete(peer);
        });
        ws.on("error", () => relay.webSocketError(peer));
      });
    })().catch(reject);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((error) => {
    clearInterval(cleanup);
    wsServer.close();
    store.close();
    throw error;
  });
  return {
    server,
    relay,
    async close() {
      clearInterval(cleanup);
      for (const set of connections.values())
        for (const peer of set) {
          relay.webSocketError(peer);
          peer.ws.terminate();
        }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      wsServer.close();
      store.close();
    },
  };
}
