import type { Section } from './types';

/**
 * The editor uses plain text: one item per line, and a line ending in ":"
 * starts a new section ("For the sauce:").
 */
export function sectionsToText(sections: Section[]): string {
  return sections
    .map((s) => (s.title ? [`${s.title}:`, ...s.items] : s.items).join('\n'))
    .join('\n\n');
}

export function textToSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: null, items: [] };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.endsWith(':') && line.length > 1) {
      if (current.title || current.items.length) sections.push(current);
      current = { title: line.slice(0, -1).trim(), items: [] };
    } else {
      current.items.push(line);
    }
  }
  if (current.title || current.items.length) sections.push(current);
  return sections;
}

export function formatMinutes(minutes: number | null): string | null {
  if (minutes == null) return null;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export function displayTime(r: {
  totalMinutes: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
}): string | null {
  const total = r.totalMinutes ?? ((r.prepMinutes ?? 0) + (r.cookMinutes ?? 0) || null);
  return formatMinutes(total);
}
