import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { z } from 'zod';

export function frozenSchema<T extends z.ZodType>(schema: T): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  return schema as unknown as StandardSchemaWithJSON<z.input<T>, z.output<T>>;
}
