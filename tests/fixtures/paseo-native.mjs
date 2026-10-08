// Run the installed native daemon in a separate process with the test's isolated
// environment. Provider binaries and model endpoints come from the test config.
import pino from "pino";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
const { createPaseoDaemon } = await import(pathToFileURL(process.argv[2]).href);
const config = JSON.parse(await readFile(process.argv[3], "utf8"));
const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
await daemon.start();
console.log(
  JSON.stringify({
    event: "fixture.ready",
    port: daemon.getListenTarget().port,
  }),
);
process.on("message", async (message) => {
  if (message !== "stop") return;
  await daemon.stop();
  process.exit(0);
});
