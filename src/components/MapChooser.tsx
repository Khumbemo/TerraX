import { MAPS, mapDef, MAP_GROUPS } from '../lib/basemaps';
import { usePrefs } from '../lib/prefs';

const GROUPS = MAP_GROUPS;

interface Props {
  idPrefix: string;
  compact?: boolean;
}

/** Base map picker and stackable overlays (each with its own opacity). */
export default function MapChooser({ idPrefix, compact }: Props) {
  const { map, updateMap, t } = usePrefs();
  const overlayIds = new Set(map.overlays.map(o => o.id));
  const overlayChoices = MAPS.filter(m => m.kind !== 'none' && m.id !== map.base && !overlayIds.has(m.id));

  return (
    <div className={`map-chooser ${compact ? 'compact' : ''}`}>
      <label className="inline-select">
        <span>{t('map.base', 'Base map')}</span>
        <select id={`${idPrefix}-base`} value={map.base} onChange={e => updateMap({ base: e.target.value, overlays: map.overlays.filter(o => o.id !== e.target.value) })}>
          <option value="auto">{__TERRAX_PREVIEW__ ? 'Automatic (built-in Natural Earth map in this preview)' : t('map.auto', 'Automatic (CARTO, follows the theme)')}</option>
          {GROUPS.filter(g => MAPS.some(m => m.group === g && !m.overlayOnly)).map(g => (
            <optgroup key={g} label={g}>
              {MAPS.filter(m => m.group === g && !m.overlayOnly).map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.needsKey ? ' · key' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {!compact && map.base !== 'auto' && <p className="field-hint">{mapDef(map.base).terms}</p>}

      <div className="map-overlays">
        <div className="eyebrow">{t('map.overlays', 'Overlays (stack several)')}</div>
        {map.overlays.map(o => {
          const d = mapDef(o.id);
          return (
            <div key={o.id} className="overlay-row">
              <span className="overlay-name" title={d.terms}>
                {d.name}
              </span>
              <input
                type="range"
                min="0.05"
                max="1"
                step="0.05"
                value={o.opacity}
                aria-label={`Opacity of ${d.name}`}
                onChange={e => updateMap({ overlays: map.overlays.map(x => (x.id === o.id ? { ...x, opacity: Number(e.target.value) } : x)) })}
              />
              <span className="num">{Math.round(o.opacity * 100)} %</span>
              <button type="button" className="link-btn" aria-label={`Remove ${d.name}`} onClick={() => updateMap({ overlays: map.overlays.filter(x => x.id !== o.id) })}>
                ×
              </button>
            </div>
          );
        })}
        <select
          id={`${idPrefix}-add-overlay`}
          value=""
          aria-label="Add an overlay"
          onChange={e => {
            if (!e.target.value) return;
            const d = mapDef(e.target.value);
            updateMap({ overlays: [...map.overlays, { id: d.id, opacity: d.builtin === 'classes' ? 0.7 : d.overlayOnly ? 1 : 0.6 }] });
          }}
        >
          <option value="">{t('map.addOverlay', '+ Add an overlay…')}</option>
          {GROUPS.map(g => {
            const list = overlayChoices.filter(m => m.group === g || (g === 'Street maps' && m.overlayOnly && m.group === 'Street maps'));
            return list.length ? (
              <optgroup key={g} label={g === 'Street maps' ? 'Street maps and labels' : g}>
                {list.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
      </div>
    </div>
  );
}
