export interface DocumentedInstant {
  iso: string;
  month: number;
  day: number;
  hour: number;
  minute: number;
  zoneName: string;
}

// RESEARCH Q4: the eight instants whose America/Chicago wall-clock parts were read identically in
// workerd and Node, across midnight and both 2026 clock changes.
export const Q4_INSTANTS: readonly DocumentedInstant[] = [
  { iso: '2026-10-21T04:30:00Z', month: 10, day: 20, hour: 23, minute: 30, zoneName: 'CDT' },
  { iso: '2026-10-21T05:30:00Z', month: 10, day: 21, hour: 0, minute: 30, zoneName: 'CDT' },
  { iso: '2026-11-01T06:30:00Z', month: 11, day: 1, hour: 1, minute: 30, zoneName: 'CDT' },
  { iso: '2026-11-01T07:30:00Z', month: 11, day: 1, hour: 1, minute: 30, zoneName: 'CST' },
  { iso: '2026-11-01T08:59:00Z', month: 11, day: 1, hour: 2, minute: 59, zoneName: 'CST' },
  { iso: '2026-11-01T10:00:00Z', month: 11, day: 1, hour: 4, minute: 0, zoneName: 'CST' },
  { iso: '2026-03-08T07:59:00Z', month: 3, day: 8, hour: 1, minute: 59, zoneName: 'CST' },
  { iso: '2026-03-08T08:00:00Z', month: 3, day: 8, hour: 3, minute: 0, zoneName: 'CDT' },
];

export const PROBE_ZONE = 'America/Chicago';
export const PROBE_DAY_START = '04:00';
