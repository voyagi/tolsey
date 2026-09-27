import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';

type JsonObject = Record<string, unknown>;

// tools/list converts every schema on every request unless the schema hands over JSON already
// computed, so the conversion runs once per isolate here, and freezing makes the objects every
// request sees literally the same.
export function frozenSchema<T extends z.ZodType>(schema: T): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  const input = Object.freeze(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })) as JsonObject;
  const output = Object.freeze(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' })) as JsonObject;
  const standard = schema['~standard'];
  return {
    '~standard': {
      version: 1,
      vendor: 'tolsey',
      validate: (value, options) => standard.validate(value, options),
      jsonSchema: { input: () => input, output: () => output },
    },
  };
}
