/**
 * Wall-clock times in a time zone (the family calendar's), without a date library.
 */

/** "2026-10-06T15:30:00": the wall-clock time of an instant in a time zone. */
export function wallTime(d: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** The instant a wall-clock time ("2026-10-06T15:30:00") happens in a time zone. */
export function zonedInstant(wall: string, timeZone: string): Date {
  const guess = new Date(`${wall}Z`);
  const offset = new Date(`${wallTime(guess, timeZone)}Z`).getTime() - guess.getTime();
  return new Date(guess.getTime() - offset);
}
