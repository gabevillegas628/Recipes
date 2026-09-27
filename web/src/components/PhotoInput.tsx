import type { ReactNode } from 'react';

/**
 * A button that picks photos. `camera` opens the rear camera straight away
 * (capture="environment"); otherwise the phone offers its library / files.
 */
export function PhotoInput({
  camera = false,
  multiple = !camera,
  disabled = false,
  className = 'btn',
  onPick,
  children,
}: {
  camera?: boolean;
  multiple?: boolean;
  disabled?: boolean;
  className?: string;
  onPick: (files: File[]) => void;
  children: ReactNode;
}) {
  return (
    <label className={`${className} ${disabled ? 'btn-disabled' : ''}`}>
      {children}
      <input
        type="file"
        accept="image/*"
        capture={camera ? 'environment' : undefined}
        multiple={multiple}
        hidden
        disabled={disabled}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) onPick(files);
          e.target.value = '';
        }}
      />
    </label>
  );
}
