export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  zoneName: string;
}

export interface KitchenSettings {
  timeZone: string;
  dayStart: string;
}

const DEFAULT_SETTINGS: KitchenSettings = { timeZone: 'America/Chicago', dayStart: '04:00' };
const MINUTES_PER_HOUR = 60;

// Building a formatter is the costly part, so one is kept per zone for the isolate's life.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// The zone is always passed: local workerd inherits the host machine's zone as its default.
export function localParts(instantMs: number, timeZone: string): LocalParts {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instantMs)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    zoneName: parts.timeZoneName,
  };
}

function minutesOfDay(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * MINUTES_PER_HOUR + minutes;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

// Calendar arithmetic on the local date only: an instant minus a fixed offset is wrong on the two
// days a year the offset changes.
export function businessDay(instantMs: number, timeZone: string, dayStart: string): string {
  const local = localParts(instantMs, timeZone);
  const beforeStart = local.hour * MINUTES_PER_HOUR + local.minute < minutesOfDay(dayStart);
  const date = new Date(Date.UTC(local.year, local.month - 1, beforeStart ? local.day - 1 : local.day));
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

export function utcIso(instantMs: number): string {
  return new Date(instantMs).toISOString();
}

export function kitchenSettings(partial: Partial<KitchenSettings>): KitchenSettings {
  return {
    timeZone: partial.timeZone ?? DEFAULT_SETTINGS.timeZone,
    dayStart: partial.dayStart ?? DEFAULT_SETTINGS.dayStart,
  };
}
