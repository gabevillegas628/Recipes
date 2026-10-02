import type { ReactNode } from 'react';

// Web addresses, email addresses and phone numbers, in that order of preference.
const PATTERN =
  /(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+\.[^\s<>"]+)|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(\+?\(?\d[\d\s().-]{6,}\d)/g;

/** Text with its links, emails and phone numbers turned into tappable links. */
export function LinkedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    let [match] = m;
    const [, url, email, phone] = m;
    // Leave trailing punctuation ("see example.com.") outside the link.
    if (url) match = match.replace(/[.,;:!?)\]'"]+$/, '');
    const href = url
      ? url.startsWith('www.')
        ? `https://${match}`
        : match
      : email
        ? `mailto:${match}`
        : `tel:${match.replace(/[^\d+]/g, '')}`;
    // Phone-ish runs that are really dates or other numbers.
    const digits = match.replace(/\D/g, '').length;
    if (phone && (digits < 7 || digits > 15 || /^\d{1,4}[-./]\d{1,2}[-./]\d{1,4}$/.test(match))) continue;
    parts.push(text.slice(last, m.index));
    parts.push(
      <a key={m.index} href={href} target={url ? '_blank' : undefined} rel={url ? 'noreferrer' : undefined}>
        {match}
      </a>,
    );
    last = m.index + match.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

/** A Maps search for a place, for a location's "Directions" link. */
export function mapsUrl(place: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
}
