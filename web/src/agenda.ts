/**
 * A day's list laid out in time: things that overlap grouped together (saying
 * who's double-booked, if anyone), free time between things, where "now" is,
 * and a warning when someone has too little time to get from one place to the next.
 */

export interface Entry<T> {
  item: T;
  title: string;
  /** ms; null for all-day and other untimed things, which go first. */
  start: number | null;
  /** ms; null (or equal to start) for a moment, like a reminder with no end. */
  end: number | null;
  /** Who it's for, by name; empty when no one in particular (or unknown). */
  who: string[];
  everyone: boolean;
  /** Marked free on the calendar: it can't clash with anything. */
  free: boolean;
  place: string | null;
}

export interface Row<T> {
  item: T;
  /** "Gabe: only 10 min after Soccer" when there's too little time to get there. */
  tight: string | null;
}

export type Line<T> =
  | { type: 'row'; row: Row<T> }
  | { type: 'overlap'; rows: Row<T>[]; clash: string[] }
  | { type: 'gap'; minutes: number; now: boolean; until: number | null };

/** Gaps shorter than this aren't worth pointing out. */
const MIN_GAP_MINUTES = 30;

const spans = <T>(e: Entry<T>) => e.start !== null && e.end !== null && e.end > e.start;
const minutes = (ms: number) => Math.round(ms / 60_000);

export function layoutDay<T>(
  entries: Entry<T>[],
  { now, gaps, travelMinutes }: { now: Date | null; gaps: boolean; travelMinutes: number },
): Line<T>[] {
  const tight = tightSqueezes(entries, travelMinutes);
  const rowOf = (e: Entry<T>): Row<T> => ({ item: e.item, tight: tight.get(e) ?? null });
  const nowMs = now?.getTime() ?? null;

  const lines: Line<T>[] = entries.filter((e) => e.start === null).map((e) => ({ type: 'row', row: rowOf(e) }));
  const timed = entries.filter((e) => e.start !== null).sort((a, b) => a.start! - b.start!);

  let lastEnd: number | null = null;
  let nowShown = false;
  // A run of things that overlap, and moments that fall inside it (listed after it).
  let cluster: Entry<T>[] = [];
  let clusterEnd = 0;
  let inside: Entry<T>[] = [];

  function gapBefore(start: number) {
    if (!gaps) return;
    const from = lastEnd ?? (nowMs !== null && nowMs < start ? nowMs : null);
    if (from === null) return;
    const isNow = nowMs !== null && !nowShown && nowMs >= from && nowMs < start;
    // While it's on, the free time is what's left of it.
    const free = minutes(start - (isNow ? nowMs! : from));
    if (free >= MIN_GAP_MINUTES || (isNow && free > 0)) {
      lines.push({ type: 'gap', minutes: free, now: isNow, until: start });
      if (isNow) nowShown = true;
    }
  }
  function flush() {
    if (!cluster.length) return;
    gapBefore(cluster[0].start!);
    if (cluster.length === 1) lines.push({ type: 'row', row: rowOf(cluster[0]) });
    else lines.push({ type: 'overlap', rows: cluster.map(rowOf), clash: clashes(cluster) });
    for (const e of inside) lines.push({ type: 'row', row: rowOf(e) });
    lastEnd = Math.max(lastEnd ?? clusterEnd, clusterEnd);
    cluster = [];
    inside = [];
  }

  for (const e of timed) {
    if (cluster.length && e.start! < clusterEnd) {
      if (spans(e)) {
        cluster.push(e);
        clusterEnd = Math.max(clusterEnd, e.end!);
      } else inside.push(e);
      continue;
    }
    flush();
    if (spans(e)) {
      cluster = [e];
      clusterEnd = e.end!;
    } else {
      gapBefore(e.start!);
      lines.push({ type: 'row', row: rowOf(e) });
      lastEnd = Math.max(lastEnd ?? e.start!, e.start!);
    }
  }
  flush();

  // Past the last thing: the rest of the day is free.
  if (gaps && nowMs !== null && !nowShown && lastEnd !== null && nowMs >= lastEnd) {
    lines.push({ type: 'gap', minutes: 0, now: true, until: null });
  }
  return lines;
}

/** Who's in two overlapping things at once. A whole-family occasion takes everyone named in the other. */
function clashes<T>(group: Entry<T>[]): string[] {
  const names = new Set<string>();
  const busy = group.filter((e) => !e.free && (e.everyone || e.who.length));
  for (const [i, a] of busy.entries()) {
    for (const b of busy.slice(i + 1)) {
      if (!(a.start! < b.end! && b.start! < a.end!)) continue;
      if (a.everyone && b.everyone) names.add('Everyone');
      else if (a.everyone) b.who.forEach((n) => names.add(n));
      else if (b.everyone) a.who.forEach((n) => names.add(n));
      else a.who.filter((n) => b.who.includes(n)).forEach((n) => names.add(n));
    }
  }
  return [...names];
}

const samePlace = (a: string | null, b: string | null) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * Someone with less than the usual travel time between one thing and the next,
 * somewhere else. Only when at least one of them says where it is: no place on
 * either could just as well be at home.
 */
function tightSqueezes<T>(entries: Entry<T>[], travelMinutes: number): Map<Entry<T>, string> {
  const out = new Map<Entry<T>, string>();
  if (travelMinutes <= 0) return out;
  const byPerson = new Map<string, Entry<T>[]>();
  for (const e of entries) {
    if (!spans(e) || e.free) continue;
    for (const name of e.who) byPerson.set(name, [...(byPerson.get(name) ?? []), e]);
  }
  const notes = new Map<Entry<T>, { names: string[]; after: Entry<T>; gap: number }>();
  for (const [name, list] of byPerson) {
    list.sort((a, b) => a.start! - b.start!);
    for (const [i, b] of list.slice(1).entries()) {
      const a = list[i];
      const gap = minutes(b.start! - a.end!);
      if (gap < 0 || gap >= travelMinutes) continue;
      if ((!a.place && !b.place) || samePlace(a.place, b.place)) continue;
      const note = notes.get(b);
      if (note && note.after === a) note.names.push(name);
      else if (!note) notes.set(b, { names: [name], after: a, gap });
    }
  }
  for (const [e, { names, after, gap }] of notes) {
    out.set(e, `${names.join(' & ')}: ${gap ? `only ${gap} min` : 'straight'} after ${after.title}`);
  }
  return out;
}

/** "45 min", "1h 30m", "2h". */
export function freeFor(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}
