import { useRef, useState, type DragEvent } from 'react';

interface Props {
  id: string;
  label: string;
  accept: string;
  hint?: string;
  busy?: boolean;
  /** Name of the file currently loaded in this slot. */
  loaded?: string | null;
  onFile: (file: File) => void;
  compact?: boolean;
}

export default function FileDrop({ id, label, accept, hint, busy, loaded, onFile, compact }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const onDrag = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDrag(true);
    else if (e.type === 'dragleave') setDrag(false);
  };

  return (
    <div
      className={`upload-zone ${compact ? 'compact' : ''} ${drag ? 'active' : ''} ${busy ? 'processing' : ''} ${loaded ? 'loaded' : ''}`}
      role="button"
      tabIndex={0}
      aria-busy={Boolean(busy)}
      aria-label={label}
      onDragEnter={onDrag}
      onDragLeave={onDrag}
      onDragOver={onDrag}
      onDrop={e => {
        onDrag(e);
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f && !busy) onFile(f);
      }}
      onClick={() => !busy && inputRef.current?.click()}
      onKeyDown={e => {
        if ((e.key === 'Enter' || e.key === ' ') && !busy) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
    >
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        hidden
        onChange={e => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
      {busy ? (
        <div className="processing-state">
          <div className="scanner-line" />
          <p>Reading…</p>
        </div>
      ) : (
        <>
          <p className="drop-label">{label}</p>
          <p className="drop-file">{loaded ? `✓ ${loaded}` : 'Drop a file or click to browse'}</p>
          {hint && <p className="upload-formats">{hint}</p>}
        </>
      )}
    </div>
  );
}
