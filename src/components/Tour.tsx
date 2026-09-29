import { useEffect, useLayoutEffect, useState } from 'react';
import { usePrefs } from '../lib/prefs';

interface Step {
  selector: string;
  key: number;
}

const STEPS: Step[] = [
  { selector: '.tool-hub, .tool-workspace', key: 1 },
  { selector: '.map-container', key: 2 },
  { selector: '.right-links-panel .chat-panel', key: 3 },
  { selector: '#nav-reports', key: 4 },
  { selector: '#nav-settings', key: 5 },
];

interface Props {
  onClose: () => void;
}

/** A short guided tour: highlights one part of the screen per step. */
export default function Tour({ onClose }: Props) {
  const { t } = usePrefs();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = STEPS[i];

  useLayoutEffect(() => {
    const el = document.querySelector(step.selector);
    if (!el) {
      setRect(null);
      return;
    }
    el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    const update = () => setRect(el.getBoundingClientRect());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI(x => Math.min(STEPS.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI(x => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const vw = window.innerWidth, vh = window.innerHeight;
  const cardW = Math.min(340, vw - 32);
  let top = vh / 2 - 90, left = vw / 2 - cardW / 2;
  if (rect) {
    const below = rect.bottom + 12;
    top = below + 180 < vh ? below : Math.max(16, rect.top - 192);
    left = Math.min(Math.max(16, rect.left), vw - cardW - 16);
  }
  const last = i === STEPS.length - 1;

  return (
    <div className="tour-layer" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {rect && <div className="tour-highlight" style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} />}
      <div className="tour-card" style={{ top, left, width: cardW }}>
        <div className="eyebrow">
          {i + 1} / {STEPS.length}
        </div>
        <h3 id="tour-title">{t(`tour.${step.key}.title`)}</h3>
        <p>{t(`tour.${step.key}.text`)}</p>
        <div className="button-row">
          <button type="button" className="link-btn" onClick={onClose}>
            {t('tour.skip')}
          </button>
          <div className="button-row push-right">
            {i > 0 && (
              <button type="button" className="btn btn-small" onClick={() => setI(i - 1)}>
                {t('tour.back')}
              </button>
            )}
            <button type="button" id="tour-next" className="btn btn-small btn-primary" autoFocus onClick={() => (last ? onClose() : setI(i + 1))}>
              {last ? t('tour.done') : t('tour.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
