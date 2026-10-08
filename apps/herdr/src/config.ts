import { z } from "zod";
import { absolutePath, commonInstanceFields } from "@agenvo/connector/config";
export const instanceConfigSchema = z.strictObject({
  ...commonInstanceFields,
  binary: absolutePath,
  cwd: absolutePath,
  kind: z.literal("herdr"),
  configRoot: absolutePath,
});
export type HerdrConfig = z.infer<typeof instanceConfigSchema>;
