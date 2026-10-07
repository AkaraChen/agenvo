import { z } from "zod";
import { absolutePath, commonInstanceFields } from "@agenvo/connector/config";
export const instanceConfigSchema = z
  .strictObject({
    ...commonInstanceFields,
    kind: z.literal("codex"),
    mode: z.enum(["managed-stdio", "attach-unix"]),
    socketPath: absolutePath.optional(),
    home: absolutePath,
  })
  .superRefine((config, ctx) => {
    if ((config.mode === "attach-unix") !== Boolean(config.socketPath))
      ctx.addIssue({
        code: "custom",
        message:
          "attach-unix requires socketPath; managed-stdio does not accept it",
      });
  });
export type CodexConfig = z.infer<typeof instanceConfigSchema>;
