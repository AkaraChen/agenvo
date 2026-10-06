// This fixture is built only by the local Workers integration suite.
import worker, { SiyinRelay, createWorker } from "../../src/relay/worker.js";
export { SiyinRelay };
const authorizedWorker = createWorker(async (request) => {
  if (request.headers.get("x-test-owner") !== "local-owner")
    throw new Error("test_owner_required");
  return "test-owner";
});
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
    url.host = "siyin.test";
    url.port = "";
    return (
      request.headers.has("x-test-owner") ? authorizedWorker : worker
    ).fetch(new Request(url, request), env, ctx);
  },
};
