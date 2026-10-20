import type { ToolAnnotations } from '@modelcontextprotocol/server';

export type ToolName =
  | 'log_reading'
  | 'record_corrective_action'
  | 'close_corrective_action'
  | 'due_now'
  | 'shift_handover'
  | 'day_sheet';

// The six tools the design names, fixed here with their descriptions. This version registers only
// log_reading and due_now. The other four are designed and not built.

/** @public The designed tool set. This version registers only log_reading and due_now. */
export const TOOL_NAMES: readonly ToolName[] = [
  'log_reading',
  'record_corrective_action',
  'close_corrective_action',
  'due_now',
  'shift_handover',
  'day_sheet',
];

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  log_reading:
    'Log a temperature reading a cook just took, in degrees Fahrenheit. Pass the cook\'s words unchanged in ' +
    'words. Put the number in value only when the cook said one, and leave value out when no number was said, ' +
    'so Tolsey can refuse the check and keep it open. A correction ("wrong number") arrives through this same ' +
    "tool, and so does the cook's answer to a question Tolsey asked, sent with that question's prompt id as " +
    'pending_prompt_id.',
  record_corrective_action:
    'Record what a cook did about an out-of-range reading: what was done to the food and, separately, what was ' +
    'done to the cause.',
  close_corrective_action:
    'Close an open corrective action with its disposition, such as discarded or rejected. A passing re-check of ' +
    'the food is logged through log_reading instead, which closes the action itself.',
  due_now:
    "Say which checks are still open today, in the kitchen's own order. A check is open while its newest " +
    'line is a refusal or a question waiting for a number. This reads the record and writes nothing.',
  shift_handover:
    'Summarise the shift for handover: the open items with the time each has left, the counts so far and the ' +
    'checks due next.',
  day_sheet: "Return a link to the printable day sheet with every reading, refusal and corrective action of the day.",
};

const WRITES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const READS: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

export const TOOL_ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
  log_reading: WRITES,
  record_corrective_action: WRITES,
  close_corrective_action: WRITES,
  due_now: READS,
  shift_handover: READS,
  day_sheet: READS,
};

/** @public The designed MCP Apps card resources. This version attaches none of them to a tool. */
export const UI_RESOURCE_URIS = {
  reading: 'ui://tolsey/reading.html',
  dueNow: 'ui://tolsey/due-now.html',
  openAction: 'ui://tolsey/open-action.html',
  handover: 'ui://tolsey/handover.html',
};
