// This fixture is built only by the local Workers integration suite.
import worker, { SiyinRelay } from "../../src/relay/worker.js";
export { SiyinRelay };
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/fixture") {
      const { method, args } = (await request.json()) as any;
      const relay = env.RELAY.getByName("owner");
      const result = await (relay as any)[method](...args);
      return Response.json(result ?? null);
    }
    const url = new URL(request.url);
    url.protocol = "https:";
    url.host = "agenvo.test";
    url.port = "";
    return worker.fetch(new Request(url, request), env, ctx);
  },
};
