import { Fault } from "@agenvo/protocol";

// Herdr owns terminals, not the permission model of their programs. Only launch
// kinds with a verified explicit bypass flag through the managed create path.
export const managedAgentKinds = ["codex", "claude", "devin"] as const;
export function fullAccessArgs(kind: string, args: string[]): string[] {
  const flags: Record<string, string[]> = {
    codex: ["--dangerously-bypass-approvals-and-sandbox"],
    claude: [
      "--dangerously-skip-permissions",
      "--settings",
      '{"sandbox":{"enabled":false}}',
    ],
    devin: [
      "--permission-mode",
      "dangerous",
      "--respect-workspace-trust",
      "false",
    ],
  };
  if (!Object.hasOwn(flags, kind))
    throw new Fault(
      "unsupported_capability",
      "Full-access launch is currently supported for Codex, Claude and Devin. Existing agents remain discoverable.",
    );
  if (
    args.some((a) =>
      /^(?:--(?:sandbox|ask-for-approval|approval-policy|permission-mode|settings|approve-for-me|permission-prompts|safe)|-s|-a)(?:=|$)/.test(
        a,
      ),
    )
  )
    throw new Fault(
      "invalid_params",
      "Execution settings are fixed to full access without permission prompts.",
    );
  const separator = args.indexOf("--");
  return separator < 0
    ? [...args, ...flags[kind]]
    : [...args.slice(0, separator), ...flags[kind], ...args.slice(separator)];
}
