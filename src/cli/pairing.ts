import { ownerOrigin, loadOwnerKey, signOwnerRequest } from "./owner-key.js";
import { Fault } from "../protocol/index.js";

export async function pairingCommand(
  action: string,
  code: string | undefined,
  options: Record<string, string | boolean>,
) {
  const origin = ownerOrigin(String(options.origin ?? ""));
  if (!["list", "approve"].includes(action))
    throw new Fault("invalid_arguments");
  const method = action === "list" ? "GET" : "POST";
  const path = "/api/admin/pairings" + (action === "approve" ? "/approve" : "");
  if (
    action === "approve" &&
    (!code || !/^[a-f0-9]{64}$/.test(String(options.fingerprint ?? "")))
  )
    throw new Fault(
      "invalid_arguments",
      "Pass a pairing code and --fingerprint from the device terminal",
    );
  const body =
    action === "list"
      ? ""
      : JSON.stringify({ code, digest: options.fingerprint });
  const key = await loadOwnerKey(origin).catch((error) => {
    if (error.code === "ENOENT")
      throw new Fault(
        "pairing_key_missing",
        "Run this command on the deployment machine with its AGENVO_CONFIG_DIR, or restore its owner key.",
      );
    throw error;
  });
  const token = await signOwnerRequest(key, origin, method, path, body);
  const response = await fetch(origin + path, {
    method,
    redirect: "error",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Fault(
      "pairing_api_rejected",
      "Pairing API returned HTTP " + response.status,
    );
  return response.json();
}
