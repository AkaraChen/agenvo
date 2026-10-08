import { z } from "zod";
import { absolutePath, commonInstanceFields } from "@agenvo/connector/config";

export const executionPolicy = {
  execution: "full-access-in-attached-host",
  approvalPolicy: "native_tool_call_allow_hook",
};

export const instanceConfigSchema = z.strictObject({
  ...commonInstanceFields,
  kind: z.literal("amp"),
  binary: absolutePath,
  cwd: absolutePath,
  bridgeDir: absolutePath,
  pluginPath: absolutePath,
});
export type AmpConfig = z.infer<typeof instanceConfigSchema>;
