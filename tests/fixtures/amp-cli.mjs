#!/usr/bin/env node
// Public CLI shape sampled without retaining real thread metadata.
if (process.argv.includes("--version")) console.log("amp-isolated-fixture");
else if (process.argv.slice(2, 4).join(" ") === "threads list") {
  const args = process.argv.slice(2);
  const offset = Number(args[args.indexOf("--offset") + 1] ?? 0);
  const limit = Number(args[args.indexOf("--limit") + 1] ?? 20);
  console.log(
    JSON.stringify(
      [
        {
          id: "T-external",
          title: "External fixture",
          updated: "2026-10-08T00:00:00Z",
          tree: "",
          messageCount: 1,
        },
      ].slice(offset, offset + limit),
    ),
  );
} else process.exitCode = 1;
