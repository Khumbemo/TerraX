import React from 'react';
import { Settings } from 'lucide-react';

const S = {
  telemetryBtn: {
    display: 'flex',
    flexDirection: 'column' as const,
    background: 'rgba(3, 7, 18, 0.8)',
    border: '1px solid #1a3a5a',
    padding: '12px 20px',
    textDecoration: 'none',
    transition: 'all 0.2s ease-in-out',
    cursor: 'pointer',
  },
  btnTitle: {
    color: '#5ab0f0',
    fontFamily: "'Space Mono', monospace",
    fontSize: '14px',
    fontWeight: 'bold',
  },
  btnSub: {
    color: '#94a3b8',
    fontFamily: "'Space Mono', monospace",
    fontSize: '11px',
    marginTop: '4px',
  }
};

const LiveTelemetryDock = () => {
    const themeColors = { accent: '#5ab0f0', border: '#1a3a5a' };
    const onMouseEnter = (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.currentTarget.style.borderColor = themeColors.accent;
      e.currentTarget.style.backgroundColor = 'rgba(90, 176, 240, 0.1)';
      e.currentTarget.style.transform = 'translateX(-5px)';
    };
    const onMouseLeave = (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.currentTarget.style.borderColor = themeColors.border;
      e.currentTarget.style.backgroundColor = 'rgba(3, 7, 18, 0.8)';
      e.currentTarget.style.transform = 'translateX(0)';
    };

    return (
        <div style={{ width: '150px', display: 'flex', flexDirection: 'column', gap: '15px' }}>
        {/* NASA WORLDVIEW LINK */}
        <a 
          href="https://worldview.earthdata.nasa.gov/" 
          target="_blank" 
          rel="noopener noreferrer"
          style={S.telemetryBtn}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          <span style={S.btnTitle}>NASA WORLDVIEW</span>
          <span style={S.btnSub}>Global Imagery</span>
        </a>

        {/* NOAA METEO LINK */}
        <a 
          href="https://nesdis.noaa.gov/imagery/satellite-maps/earth-real-time" 
          target="_blank" 
          rel="noopener noreferrer"
          style={S.telemetryBtn}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          <span style={S.btnTitle}>NOAA METEO</span>
          <span style={S.btnSub}>Radar / Storm</span>
        </a>

        {/* VENTUSKY KINEMATICS LINK */}
        <a 
          href="https://www.ventusky.com/" 
          target="_blank" 
          rel="noopener noreferrer"
          style={S.telemetryBtn}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          <span style={S.btnTitle}>VENTUSKY</span>
          <span style={S.btnSub}>Kinematics</span>
        </a>

        {/* NASA FIRMS LINK */}
        <a 
          href="https://firms.modaps.eosdis.nasa.gov/map/" 
          target="_blank" 
          rel="noopener noreferrer"
          style={S.telemetryBtn}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          <span style={S.btnTitle}>NASA FIRMS</span>
          <span style={S.btnSub}>Thermal Disturbance</span>
        </a>

        {/* SPACE WEATHER / GPS LINK */}
        <a 
          href="https://www.swpc.noaa.gov/communities/space-weather-enthusiasts-dashboard" 
          target="_blank" 
          rel="noopener noreferrer"
          style={S.telemetryBtn}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          <span style={S.btnTitle}>NOAA SWPC</span>
          <span style={S.btnSub}>GNSS / Solar Physics</span>
        </a>

        {/* GLOBAL FOREST WATCH LINK */}
        <a 
          href="https://www.globalforestwatch.org/map/" 
          target="_blank" 
          rel="noopener noreferrer"
          style={S.telemetryBtn}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          <span style={S.btnTitle}>FOREST WATCH</span>
          <span style={S.btnSub}>NRT Canopy Alerts</span>
        </a>
      </div>
    );
};

export default LiveTelemetryDock;
