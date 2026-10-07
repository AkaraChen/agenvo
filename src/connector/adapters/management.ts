import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Fault, type Outcome } from "../../protocol/index.js";
import { type Method } from "./adapter.js";
import { Observations } from "./observations.js";

export const reference = z.string().min(1).max(8192);
export const pagination = {
  cursor: z.string().max(8192).optional(),
  limit: z.number().int().min(1).max(50).default(20),
};
export const providerOptions = z.record(z.string(), z.unknown()).default({});
export type NativeCall = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Outcome>;
type Operation = Method & {
  run(input: Record<string, any>): Promise<Outcome>;
  schema: z.ZodType;
};

// References bind an object to this adapter incarnation without a persistent
// registry. A restart requires rediscovery; native identities remain in results.
export class References {
  private key = randomBytes(32);
  reset() {
    this.key = randomBytes(32);
  }
  issue(kind: string, value: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify({ kind, value })).toString(
      "base64url",
    );
    return (
      payload +
      "." +
      createHmac("sha256", this.key).update(payload).digest("base64url")
    );
  }
  read<T>(token: string, kind: string): T {
    const [payload, signature, extra] = token.split(".");
    const actual = Buffer.from(signature ?? "", "base64url");
    const expected = createHmac("sha256", this.key).update(payload).digest();
    if (
      extra ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new Fault(
        "stale_reference",
        "Rediscover the object on this instance.",
      );
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (decoded.kind !== kind) throw new Fault("invalid_reference");
    return decoded.value;
  }
}

export abstract class AgentManagement {
  readonly refs = new References();
  readonly observations = new Observations();
  protected operations = new Map<string, Operation>();
  abstract capabilities(): Record<string, unknown>;
  constructor(protected native: NativeCall) {}
  protected define(
    name: string,
    schema: z.ZodType,
    readOnly: boolean,
    description: string,
    run: Operation["run"],
    inputSchema?: Record<string, unknown>,
  ) {
    const fullName = "management." + name;
    this.operations.set(fullName, {
      name: fullName,
      schema,
      readOnly,
      description,
      run,
      inputSchema:
        inputSchema ?? z.toJSONSchema(schema, { unrepresentable: "any" }),
    });
  }
  methods(): Method[] {
    return [...this.operations.values()].map(
      ({ name, readOnly, description, inputSchema }) => ({
        name,
        readOnly,
        description,
        inputSchema,
      }),
    );
  }
  async call(name: string, input: Record<string, unknown>): Promise<Outcome> {
    const operation = this.operations.get(name);
    if (!operation) throw new Fault("unsupported_capability");
    const parsed = operation.schema.safeParse(input);
    if (!parsed.success) throw new Fault("invalid_params");
    return operation.run(parsed.data as Record<string, any>);
  }
  reset() {
    this.refs.reset();
    this.observations.reset();
  }
}

// Mappings may not discard an uncertain or failed native outcome.
export function mapped(
  outcome: Outcome,
  map: (result: any) => unknown,
): Outcome {
  if (outcome.error || outcome.execution !== "accepted") return outcome;
  return { ...outcome, result: map(outcome.result) };
}

export function optionsSchema(
  base: z.ZodType,
  native: Method,
  excluded: string[],
) {
  const schema = structuredClone(native.inputSchema) as any;
  schema.properties = Object.fromEntries(
    Object.entries(schema.properties ?? {}).filter(
      ([key]) => !excluded.includes(key),
    ),
  );
  schema.required = (schema.required ?? []).filter(
    (key: string) => !excluded.includes(key),
  );
  // Native references are rooted at the final document, not the nested options.
  const { definitions, $defs, $schema, ...options } = schema;
  const result = z.toJSONSchema(base, { unrepresentable: "any" }) as any;
  result.properties.providerOptions = options;
  if (definitions) result.definitions = definitions;
  if ($defs) result.$defs = $defs;
  return result;
}

export function nativeOptions(
  options: Record<string, unknown>,
  excluded: string[],
) {
  if (excluded.some((key) => key in options))
    throw new Fault(
      "invalid_params",
      "Native identities must come from management references.",
    );
  return options;
}
