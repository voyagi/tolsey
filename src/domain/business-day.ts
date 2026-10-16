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

// A zone Intl does not know would throw at the first reading of a shift, so settings are checked
// with this when they load.
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
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

const MINUTE_MS = 60_000;
const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS;
const HOURS_ON_A_CLOCK_FACE = 12;
const NOON = 12;

// The wall clock minus the instant, both to the minute, so the offset comes from the zone's own
// rules as Intl reports them and never from the host's zone.
function offsetMinutes(instantMs: number, timeZone: string): number {
  const local = localParts(instantMs, timeZone);
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const instantToMinute = instantMs - (((instantMs % MINUTE_MS) + MINUTE_MS) % MINUTE_MS);
  return Math.round((wall - instantToMinute) / MINUTE_MS);
}

function nearClockChange(instantMs: number, timeZone: string): boolean {
  const offset = offsetMinutes(instantMs, timeZone);
  return (
    offsetMinutes(instantMs - HOUR_MS, timeZone) !== offset || offsetMinutes(instantMs + HOUR_MS, timeZone) !== offset
  );
}

// "1:30 AM" alone is ambiguous on the night the clocks go back, so the zone abbreviation is added
// within an hour of a change.
export function lineTimeLabel(instantMs: number, timeZone: string): string {
  const local = localParts(instantMs, timeZone);
  const hour = local.hour % HOURS_ON_A_CLOCK_FACE || HOURS_ON_A_CLOCK_FACE;
  const clock = `${hour}:${pad(local.minute, 2)} ${local.hour < NOON ? 'AM' : 'PM'}`;
  return nearClockChange(instantMs, timeZone) ? `${clock} ${local.zoneName}` : clock;
}

const WELL_FORMED_CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
// A US clock change repeats or skips the hour from 01:00 to 03:00 local, so a day starting inside
// it would begin twice or never on those two nights.
const CHANGE_HOURS_FROM = 1 * MINUTES_PER_HOUR;
const CHANGE_HOURS_UNTIL = 3 * MINUTES_PER_HOUR;

export function validateDayStart(clock: string): boolean {
  if (!WELL_FORMED_CLOCK.test(clock)) return false;
  const minutes = minutesOfDay(clock);
  return minutes < CHANGE_HOURS_FROM || minutes >= CHANGE_HOURS_UNTIL;
}

const BUSINESS_DAY = /^\d{2}(\d{2})-(\d{2})-(\d{2})$/;
const DAY_LINE_DIGITS = 3;

// The same shape the D1 INSERT writes into result_json, so a line printed from memory and one
// read back from storage carry the same code.
export function recordCode(day: string, dayLine: number): string {
  const match = BUSINESS_DAY.exec(day);
  if (!match || !Number.isInteger(dayLine) || dayLine < 1) {
    throw new RangeError('a record code needs a YYYY-MM-DD business day and a positive line number');
  }
  const [, year, month, date] = match;
  return `${year}${month}${date}-${pad(dayLine, DAY_LINE_DIGITS)}`;
}

export function kitchenSettings(partial: Partial<KitchenSettings>): KitchenSettings {
  const settings = {
    timeZone: partial.timeZone ?? DEFAULT_SETTINGS.timeZone,
    dayStart: partial.dayStart ?? DEFAULT_SETTINGS.dayStart,
  };
  if (!validateDayStart(settings.dayStart)) {
    throw new RangeError(
      `day start ${settings.dayStart} is refused: give HH:MM outside 01:00 to 03:00, the hours a clock change repeats or skips`,
    );
  }
  if (!isKnownTimeZone(settings.timeZone)) {
    throw new RangeError(`time zone ${settings.timeZone} is refused: give a zone name Intl knows, such as America/Chicago`);
  }
  return settings;
}
