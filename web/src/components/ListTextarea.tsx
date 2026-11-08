import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { continueList, parseLine } from '../notes';

/**
 * A note's details box that keeps lists going: Enter on "- [ ] milk" starts "- [ ] ",
 * Enter on an empty item ends the list. The buttons start a checklist or bullet line.
 */
export function ListTextarea({
  id,
  value,
  onChange,
  rows,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once the new text is in.
  const caret = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (caret.current === null || !ref.current) return;
    ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  const replace = (from: number, to: number, text: string) => {
    caret.current = from + text.length;
    onChange(value.slice(0, from) + text + value.slice(to));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) return;
    const at = el.selectionStart;
    const start = value.lastIndexOf('\n', at - 1) + 1;
    const end = value.indexOf('\n', at) === -1 ? value.length : value.indexOf('\n', at);
    const line = value.slice(start, end);
    const next = continueList(line);
    if (next === null) return;
    e.preventDefault();
    // An empty item: drop its marker and stop the list.
    if (!parseLine(line).text.trim()) replace(start, end, '');
    else replace(at, at, `\n${next}`);
  };

  const startLine = (prefix: string) => {
    const el = ref.current;
    const at = el?.selectionEnd ?? value.length;
    const start = value.lastIndexOf('\n', at - 1) + 1;
    const end = value.indexOf('\n', at) === -1 ? value.length : value.indexOf('\n', at);
    const line = value.slice(start, end);
    // A blank line becomes the item; otherwise the item goes on a new line after this one.
    if (!line.trim()) replace(start, end, prefix);
    else replace(end, end, `\n${prefix}`);
    el?.focus();
  };

  return (
    <>
      <textarea id={id} ref={ref} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
      <div className="list-buttons">
        <button type="button" className="btn btn-small" onClick={() => startLine('- [ ] ')}>
          ☐ Checklist
        </button>
        <button type="button" className="btn btn-small" onClick={() => startLine('- ')}>
          • Bullet
        </button>
      </div>
    </>
  );
}
