import type { CSSProperties, ReactNode } from 'react';
import { parseLine, type BodyLine } from '../notes';
import { LinkedText } from './LinkedText';

type Item = Exclude<BodyLine, { type: 'text' }> & { index: number };
type Block = { kind: 'text'; lines: string[] } | { kind: 'ul' | 'ol'; items: Item[] };

/** Splits details into runs of plain text, bullet or checklist items, and numbered items. */
function blocksOf(body: string): Block[] {
  const blocks: Block[] = [];
  body.split('\n').forEach((raw, index) => {
    const line = parseLine(raw);
    const last = blocks[blocks.length - 1];
    if (line.type === 'text') {
      if (last?.kind === 'text') last.lines.push(line.text);
      else if (line.text.trim()) blocks.push({ kind: 'text', lines: [line.text] });
      return;
    }
    const kind = line.type === 'number' ? 'ol' : 'ul';
    const item = { ...line, index };
    if (last?.kind === kind) last.items.push(item);
    else blocks.push({ kind, items: [item] });
  });
  // Blank lines just before a list only separate it from the text.
  for (const b of blocks) if (b.kind === 'text') while (b.lines.length && !b.lines[b.lines.length - 1].trim()) b.lines.pop();
  return blocks;
}

/**
 * A note's details, with lists drawn as lists. Checklist items can be ticked right here:
 * `onToggle` gets the line number to flip (see toggleCheck).
 */
export function NoteBody({ body, onToggle }: { body: string; onToggle?: (index: number) => void }) {
  return (
    <div className="note-body">
      {blocksOf(body).map((b, i): ReactNode => {
        if (b.kind === 'text')
          return (
            <p key={i}>
              <LinkedText text={b.lines.join('\n')} />
            </p>
          );
        const items = b.items.map((it) => (
          <li
            key={it.index}
            className={it.type === 'check' ? `note-check ${it.checked ? 'done' : ''}` : undefined}
            style={it.indent ? ({ '--indent': it.indent } as CSSProperties) : undefined}
          >
            {it.type === 'check' ? (
              <label>
                <input
                  type="checkbox"
                  checked={it.checked}
                  disabled={!onToggle}
                  onChange={() => onToggle?.(it.index)}
                />
                <span>
                  <LinkedText text={it.text} />
                </span>
              </label>
            ) : (
              <LinkedText text={it.text} />
            )}
          </li>
        ));
        return b.kind === 'ol' ? (
          <ol key={i} start={parseInt(b.items[0].marker, 10) || 1}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      })}
    </div>
  );
}
