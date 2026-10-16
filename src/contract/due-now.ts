import { z } from 'zod';
import { CONTRACT_VERSION } from './log-reading';

export const DUE_NOW = 'due_now';

// No argument chooses the kitchen or the day: the path names the kitchen and the server's clock the
// day, so a host cannot read another kitchen's record through this tool.
export const DueNowInputSchema = z.object({}).strict();

const OpenCheckSchema = z.object({ id: z.string(), name: z.string() }).strict();

export const DueNowOutputSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    businessDay: z.string(),
    timeZone: z.string(),
    openChecks: z.array(OpenCheckSchema),
  })
  .strict();
export type DueNowOutput = z.infer<typeof DueNowOutputSchema>;
