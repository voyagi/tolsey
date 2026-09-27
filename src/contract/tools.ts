import type { ToolAnnotations } from '@modelcontextprotocol/server';

export type ToolName =
  | 'log_reading'
  | 'record_corrective_action'
  | 'close_corrective_action'
  | 'due_now'
  | 'shift_handover'
  | 'day_sheet';

export const TOOL_NAMES: readonly ToolName[] = ['log_reading'];

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  log_reading: '',
  record_corrective_action: '',
  close_corrective_action: '',
  due_now: '',
  shift_handover: '',
  day_sheet: '',
};

export const TOOL_ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
  log_reading: {},
  record_corrective_action: {},
  close_corrective_action: {},
  due_now: {},
  shift_handover: {},
  day_sheet: {},
};

export const UI_RESOURCE_URIS = { reading: '', dueNow: '', openAction: '', handover: '' };
