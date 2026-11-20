/**
 * A small schema language for command arguments. One definition gives both
 * validation (with readable error paths) and the JSON Schema that the agent
 * API publishes (MCP tool input schemas, docs/agent-api.md).
 */

export type JsonSchema = Record<string, unknown>;

export interface Schema<T> {
  readonly json: JsonSchema;
  /** Throws a `SchemaError` naming the path of the first problem. */
  parse(v: unknown, path?: string): T;
  /** Marks an object property as optional. */
  readonly optional?: boolean;
}

export class SchemaError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(path ? `${path}: ${message}` : message);
  }
}

const where = (path: string | undefined): string => path ?? '';
const fail = (path: string | undefined, msg: string): never => {
  throw new SchemaError(where(path), msg);
};
const describe = (json: JsonSchema, description?: string): JsonSchema =>
  description ? { ...json, description } : json;

export const s = {
  string(
    o: { enum?: readonly string[]; maxLength?: number; description?: string } = {},
  ): Schema<string> {
    const maxLength = o.maxLength ?? 1000;
    return {
      json: describe(
        { type: 'string', ...(o.enum ? { enum: [...o.enum] } : {}), maxLength },
        o.description,
      ),
      parse(v, path) {
        if (typeof v !== 'string') return fail(path, 'must be a string');
        if (v.length > maxLength) return fail(path, `must be at most ${maxLength} characters`);
        if (o.enum && !o.enum.includes(v)) return fail(path, `must be one of ${o.enum.join(', ')}`);
        return v;
      },
    };
  },

  number(
    o: { min?: number; max?: number; integer?: boolean; description?: string } = {},
  ): Schema<number> {
    return {
      json: describe(
        {
          type: o.integer ? 'integer' : 'number',
          ...(o.min !== undefined ? { minimum: o.min } : {}),
          ...(o.max !== undefined ? { maximum: o.max } : {}),
        },
        o.description,
      ),
      parse(v, path) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return fail(path, 'must be a number');
        if (o.integer && !Number.isInteger(v)) return fail(path, 'must be an integer');
        if (o.min !== undefined && v < o.min) return fail(path, `must be at least ${o.min}`);
        if (o.max !== undefined && v > o.max) return fail(path, `must be at most ${o.max}`);
        return v;
      },
    };
  },

  boolean(description?: string): Schema<boolean> {
    return {
      json: describe({ type: 'boolean' }, description),
      parse: (v, path) => (typeof v === 'boolean' ? v : fail(path, 'must be true or false')),
    };
  },

  array<T>(item: Schema<T>, o: { maxItems?: number; description?: string } = {}): Schema<T[]> {
    const maxItems = o.maxItems ?? 1000;
    return {
      json: describe({ type: 'array', items: item.json, maxItems }, o.description),
      parse(v, path) {
        if (!Array.isArray(v)) return fail(path, 'must be an array');
        if (v.length > maxItems) return fail(path, `must have at most ${maxItems} items`);
        return v.map((x, i) => item.parse(x, `${where(path)}[${i}]`));
      },
    };
  },

  /** An object whose keys are free (parameter ids, for example). */
  record<T>(
    value: Schema<T>,
    o: { maxKeys?: number; description?: string } = {},
  ): Schema<Record<string, T>> {
    const maxKeys = o.maxKeys ?? 1000;
    return {
      json: describe({ type: 'object', additionalProperties: value.json }, o.description),
      parse(v, path) {
        if (typeof v !== 'object' || v === null || Array.isArray(v))
          return fail(path, 'must be an object');
        const entries = Object.entries(v);
        if (entries.length > maxKeys) return fail(path, `must have at most ${maxKeys} keys`);
        const out: Record<string, T> = {};
        for (const [k, x] of entries) out[k] = value.parse(x, path ? `${path}.${k}` : k);
        return out;
      },
    };
  },

  object<P extends Record<string, Schema<unknown>>>(
    props: P,
    description?: string,
  ): Schema<{
    [K in keyof P]: P[K] extends Schema<infer T>
      ? P[K]['optional'] extends true
        ? T | undefined
        : T
      : never;
  }> {
    const required = Object.entries(props)
      .filter(([, p]) => !p.optional)
      .map(([k]) => k);
    return {
      json: describe(
        {
          type: 'object',
          properties: Object.fromEntries(Object.entries(props).map(([k, p]) => [k, p.json])),
          ...(required.length ? { required } : {}),
          additionalProperties: false,
        },
        description,
      ),
      parse(v, path) {
        if (v === undefined && required.length === 0) v = {};
        if (typeof v !== 'object' || v === null || Array.isArray(v))
          return fail(path, 'must be an object');
        const o = v as Record<string, unknown>;
        for (const k of Object.keys(o))
          if (!(k in props)) fail(path ? `${path}.${k}` : k, 'is not a known argument');
        const out: Record<string, unknown> = {};
        for (const [k, p] of Object.entries(props)) {
          const sub = path ? `${path}.${k}` : k;
          if (o[k] === undefined) {
            if (!p.optional) fail(sub, 'is required');
            continue;
          }
          out[k] = p.parse(o[k], sub);
        }
        return out as never;
      },
    };
  },

  optional<T>(inner: Schema<T>): Schema<T | undefined> & { optional: true } {
    return { json: inner.json, parse: (v, path) => inner.parse(v, path), optional: true };
  },

  /** Either of several schemas (the first that accepts the value). */
  oneOf<T>(options: Schema<T>[], description?: string): Schema<T> {
    return {
      json: describe({ anyOf: options.map((o) => o.json) }, description),
      parse(v, path) {
        let first: unknown;
        for (const o of options) {
          try {
            return o.parse(v, path);
          } catch (e) {
            first ??= e;
          }
        }
        throw first;
      },
    };
  },

  /** Any JSON value (checked by the command itself). */
  any(description?: string): Schema<unknown> {
    return { json: describe({}, description), parse: (v) => v };
  },
};

export type Infer<S> = S extends Schema<infer T> ? T : never;
