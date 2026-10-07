import { ownerOrigin, adminRequest } from "./admin-client.js";
import { Fault } from "@agenvo/protocol";
type Options = Record<string, string | boolean>;
export async function adminCommand(
  action: string,
  kind: string | undefined,
  options: Options,
) {
  const origin = ownerOrigin(String(options.origin ?? ""));
  let path: string,
    body = "",
    method = "POST";
  if (action === "state") {
    path = "/api/admin/state";
    method = "GET";
  } else if (action === "approve-instance") {
    if (
      !options["device-id"] ||
      !options["instance-id"] ||
      !options.fingerprint
    )
      throw new Fault("invalid_arguments");
    path = "/api/admin/instances/approve";
    body = JSON.stringify({
      deviceId: options["device-id"],
      instanceId: options["instance-id"],
      fingerprint: options.fingerprint,
    });
  } else if (action === "revoke") {
    if (
      !["device", "instance", "grant"].includes(kind ?? "") ||
      !options.id ||
      (kind === "instance" && !options["instance-id"])
    )
      throw new Fault("invalid_arguments");
    path = "/api/admin/revoke";
    body = JSON.stringify({
      kind,
      id: options.id,
      ...(options["instance-id"] ? { instanceId: options["instance-id"] } : {}),
    });
  } else throw new Fault("invalid_arguments");
  return adminRequest(origin, method, path, body);
}
