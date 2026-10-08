import { VERSION } from "@agenvo/protocol";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execa as exec } from "execa";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { isolatedEnvironment, until } from "../support/environment.js";
import { eventsLab } from "../support/events-lab.js";
import { serviceDefinition } from "@agenvo/connector/cli/service";
import { pathToFileURL } from "node:url";

const repository = resolve(".");

test(
  "release tarballs install outside the workspace and expose isolated, usable applications",
  { timeout: 180000 },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "agenvo-packages-")),
    );
    t.after(() =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    );
    const installed = new Map<string, string>();
    for (const app of ["herdr", "codex-app-server", "server"]) {
      await exec(
        "npm",
        ["pack", "--workspace", "@agenvo/" + app, "--pack-destination", root],
        { cwd: repository },
      );
      const prefix = join(root, app);
      await mkdir(prefix);
      await writeFile(join(prefix, "package.json"), '{"private":true}');
      await exec(
        "npm",
        [
          "install",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          join(root, `agenvo-${app}-${VERSION}.tgz`),
        ],
        { cwd: prefix },
      );
      const entry = join(
        prefix,
        "node_modules",
        "@agenvo",
        app,
        "dist",
        "cli.js",
      );
      installed.set(app, entry);
      const { stdout } = await exec(
        join(prefix, "node_modules", ".bin", "agenvo-" + app),
        ["--help"],
        {
          cwd: root,
          env: isolatedEnvironment(root),
        },
      );
      assert.match(stdout, new RegExp("agenvo-" + app));
      const bundle = await readFile(entry, "utf8");
      assert.doesNotMatch(bundle, /(?:from|import)\s*["']@agenvo\//);
      const manifest = JSON.parse(
        await readFile(
          join(prefix, "node_modules", "@agenvo", app, "package.json"),
          "utf8",
        ),
      );
      assert.equal(manifest.private, undefined);
      assert.equal(
        Object.keys(manifest.dependencies).some((name) =>
          name.startsWith("@agenvo/"),
        ),
        false,
      );
      if (app !== "server") {
        assert.doesNotMatch(
          bundle,
          /from ["']express|@cloudflare\/workers-oauth-provider/,
        );
        assert.equal(
          manifest.dependencies["@modelcontextprotocol/server"],
          undefined,
        );
        const status = JSON.parse(
          (
            await exec(process.execPath, [entry, "status", "--json"], {
              cwd: root,
              env: isolatedEnvironment(root),
            })
          ).stdout,
        );
        assert.equal(status.configDir, join(root, ".config", "agenvo", app));
      }
      const def = serviceDefinition(
        join(root, ".config", "agenvo", app),
        pathToFileURL(entry).href,
        "linux",
      );
      assert.ok(def.content.includes(entry.replaceAll("\\", "\\\\")));
    }
    assert.notEqual(
      serviceDefinition(
        join(root, "herdr"),
        pathToFileURL(installed.get("herdr")!).href,
        "linux",
      ).name,
      serviceDefinition(
        join(root, "codex"),
        pathToFileURL(installed.get("codex-app-server")!).href,
        "linux",
      ).name,
    );

    // Exercise CLI configuration and pairing against an isolated HTTPS Relay.
    const lab = await eventsLab(t);
    const cli = installed.get("codex-app-server")!;
    const env = {
      ...isolatedEnvironment(root),
      NODE_EXTRA_CA_CERTS: lab.ca,
      AGENVO_ADMIN_SECRET: lab.ownerSecret,
    };
    await exec(
      process.execPath,
      [
        cli,
        "instance",
        "add",
        "--id",
        "test",
        "--binary",
        resolve("tests/fixtures/codex-backend.mjs"),
        "--cwd",
        root,
      ],
      { cwd: root, env },
    );
    await exec(process.execPath, [cli, "connect", lab.origin, "--approve"], {
      cwd: root,
      env,
    });
    const dir = join(root, ".config", "agenvo", "codex-app-server");
    const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
    assert.ok(config.deviceId);
    // A wrong executable must reject this installation before opening a connection.
    await assert.rejects(
      exec(process.execPath, [installed.get("herdr")!, "run"], {
        cwd: root,
        env: { ...env, AGENVO_CONFIG_DIR: dir },
      }),
    );
    const child = spawn(process.execPath, [cli, "run"], {
      cwd: root,
      env,
      stdio: "pipe",
    });
    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
    });
    await until(
      async () =>
        JSON.parse(
          await readFile(join(dir, "status.json"), "utf8").catch(() => "{}"),
        ),
      (s) => s.state === "online",
    );
    const services = await lab.call(
      config.deviceId,
      "test",
      "management.services.list",
    );
    const thread = await lab.call(
      config.deviceId,
      "test",
      "management.threads.create",
      { serviceRef: services.items[0].serviceRef },
    );
    assert.ok(thread.thread.threadRef);
    await exec(process.execPath, [cli, "disconnect"], { cwd: root, env });
    await exited;
    assert.equal(
      JSON.parse(await readFile(join(dir, "config.json"), "utf8")).deviceId,
      undefined,
    );

    // The independently installed server must start without repository sources.
    const server = installed.get("server")!;
    const configPath = join(root, "relay.json");
    await exec(
      process.execPath,
      [
        server,
        "init",
        "--origin",
        "https://relay.example",
        "--data-dir",
        join(root, "data"),
        "--port",
        "0",
        "--output",
        configPath,
      ],
      { cwd: root, env },
    );
    const proc = spawn(
      process.execPath,
      [server, "serve", "--config", configPath],
      { cwd: root, env, stdio: "pipe" },
    );
    const stopped = once(proc, "exit");
    t.after(async () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGTERM");
        await stopped;
      }
    });
    let log = "";
    proc.stdout.on("data", (chunk) => (log += chunk));
    proc.stderr.on("data", (chunk) => (log += chunk));
    const port = await until(() => {
      if (proc.exitCode !== null) throw new Error(log);
      const line = log
        .split("\n")
        .find(
          (line) =>
            line.startsWith("{") && JSON.parse(line).event === "server.started",
        );
      return line ? JSON.parse(line).listening.port : undefined;
    }, Boolean);
    const health = await new Promise<string>((resolve, reject) => {
      request(
        {
          hostname: "127.0.0.1",
          port: Number(port),
          path: "/health",
          headers: { Host: "relay.example" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve(body));
        },
      )
        .on("error", reject)
        .end();
    });
    assert.equal(JSON.parse(health).service, "agenvo");
  },
);
