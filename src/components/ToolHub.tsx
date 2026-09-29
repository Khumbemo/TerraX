import { usePrefs } from '../lib/prefs';
import { TOOLS, type ToolId } from '../lib/tools/registry';

interface Props {
  onOpen: (id: ToolId) => void;
}

export default function ToolHub({ onOpen }: Props) {
  const { t } = usePrefs();
  const note = t('hub.englishNote');
  return (
    <section className="tool-hub" aria-label="Tools">
      <div className="tool-hub-head">
        <h2>{t('hub.title')}</h2>
        <p className="muted">
          {t('hub.intro')}
          {note && ` ${note}`}
        </p>
      </div>
      <div className="tool-grid">
        {TOOLS.map(tool => (
          <button key={tool.id} type="button" className={`tool-card tool-${tool.id}`} data-name={tool.name} onClick={() => onOpen(tool.id)}>
            <span className="tool-mark" aria-hidden="true">
              {tool.mark}
            </span>
            <span className="tool-group">{t(`tool.${tool.id}.group`, tool.group)}</span>
            <span className="tool-name">{t(`tool.${tool.id}.name`, tool.name)}</span>
            <span className="tool-summary">{t(`tool.${tool.id}.summary`, tool.summary)}</span>
            <ul className="tool-measures">
              {tool.measures.map(m => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <span className="tool-formats">{tool.formats}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
