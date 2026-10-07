import { Fault } from "@agenvo/protocol";
export function ownerOrigin(value: string) {
  if (!value) throw new Fault("origin_required", "Pass --origin https://RELAY");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value)
    throw new Fault("https_origin_required");
  return url.origin;
}
export async function adminRequest(
  origin: string,
  method: string,
  path: string,
  body = "",
) {
  const secret = process.env.AGENVO_ADMIN_SECRET;
  if (!secret)
    throw new Fault(
      "admin_secret_required",
      "Set AGENVO_ADMIN_SECRET for explicit administrator automation, or use the management page.",
    );
  const response = await fetch(origin + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + secret,
      "Content-Type": "application/json",
    },
    ...(body ? { body } : {}),
  });
  if (!response.ok)
    throw new Fault(
      "admin_api_rejected",
      "Admin API returned HTTP " + response.status,
    );
  return response.json();
}
