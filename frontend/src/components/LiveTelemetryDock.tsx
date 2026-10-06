const LINKS = [
  { href: 'https://worldview.earthdata.nasa.gov/', title: 'NASA Worldview', sub: 'Near-real-time global imagery' },
  { href: 'https://firms.modaps.eosdis.nasa.gov/map/', title: 'NASA FIRMS', sub: 'Active fire detections' },
  { href: 'https://www.globalforestwatch.org/map/', title: 'Global Forest Watch', sub: 'Tree cover loss and alerts' },
  { href: 'https://code.earthengine.google.com/', title: 'Earth Engine', sub: 'Code editor' },
  { href: 'https://www.swpc.noaa.gov/products/planetary-k-index', title: 'NOAA SWPC', sub: 'Planetary K-index' },
  { href: 'https://www.ventusky.com/', title: 'Ventusky', sub: 'Weather models' },
];

export default function LiveTelemetryDock() {
  return (
    <nav className="link-dock" aria-label="External data portals">
      <div className="eyebrow">Data portals</div>
      {LINKS.map(l => (
        <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer" className="dock-link">
          <span className="dock-title">{l.title} ↗</span>
          <span className="dock-sub">{l.sub}</span>
        </a>
      ))}
    </nav>
  );
}
