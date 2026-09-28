import { TOOLS, type ToolId } from '../lib/tools/registry';

interface Props {
  onOpen: (id: ToolId) => void;
}

export default function ToolHub({ onOpen }: Props) {
  return (
    <section className="tool-hub" aria-label="Tools">
      <div className="tool-hub-head">
        <h2>Tools</h2>
        <p className="muted">Choose an analysis, then upload your GIS files. Every tool has sample data to try it first.</p>
      </div>
      <div className="tool-grid">
        {TOOLS.map(t => (
          <button key={t.id} type="button" className={`tool-card tool-${t.id}`} onClick={() => onOpen(t.id)}>
            <span className="tool-mark" aria-hidden="true">
              {t.mark}
            </span>
            <span className="tool-group">{t.group}</span>
            <span className="tool-name">{t.name}</span>
            <span className="tool-summary">{t.summary}</span>
            <ul className="tool-measures">
              {t.measures.map(m => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <span className="tool-formats">{t.formats}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
