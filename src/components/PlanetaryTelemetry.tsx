import React, { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import SunCalc from 'suncalc';

// --- PERFECT TELEMETRY COMPONENT (Left Panel) ---
const TelemetryRow = ({ label, value, unit = "" }: { label: string; value: string | number; unit?: string }) => (
  <div style={{
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: '8px',
    fontSize: '11px',
    fontFamily: "'Space Mono', monospace",
    letterSpacing: '0.5px',
    whiteSpace: 'nowrap' // CRITICAL: Stops the text from stacking
  }}>
    <span style={{ color: '#475569', marginRight: '10px' }}>{label}:</span>
    <span style={{ color: '#f8fafc', fontWeight: '700' }}>
      {value}{unit}
    </span>
  </div>
);

const PlanetaryTelemetry = () => {
  const mountRef = useRef(null);
  
  // Exact coordinates for Kohima, Nagaland
  const TARGET_LAT = 25.674;
  const TARGET_LON = 94.108;

  const [timeData, setTimeData] = useState({
    utcTime: 'CALCULATING...',
    localSolarTime: 'CALCULATING...',
  });

  const [solarData, setSolarData] = useState({
    zenith: '0.00',
    azimuth: '0.00',
    altitude: '0.00',
  });

  // --- 3D ENGINE SETUP (React 18 Safe) ---
  useEffect(() => {
    const currentMount = mountRef.current;
    if (!currentMount) return;

    // Clear any existing canvases (React Strict Mode protection)
    while (currentMount.firstChild) {
      currentMount.removeChild(currentMount.firstChild);
    }

    // 1. Scene, Camera, Renderer
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    
    // Size perfectly to fit the sidebar panel
    renderer.setSize(200, 200); 
    
    // THIS IS THE SECRET FOR HIGH RESOLUTION:
    renderer.setPixelRatio(window.devicePixelRatio); 
    
    currentMount.appendChild(renderer.domElement);

    // Create a group to handle Earth's axial tilt (23.5 degrees)
    const earthGroup = new THREE.Group();
    earthGroup.rotation.z = 23.5 * (Math.PI / 180);
    scene.add(earthGroup);

    // 2. High-Tech Wireframe Globe
    const globeGeo = new THREE.SphereGeometry(1.5, 32, 32);
    const globeMat = new THREE.MeshBasicMaterial({ 
      color: 0x0ea5e9, // TerraSense Cyan
      wireframe: true, 
      transparent: true, 
      opacity: 0.15 
    });
    const globe = new THREE.Mesh(globeGeo, globeMat);
    earthGroup.add(globe);

    // Core glow for depth
    const coreGeo = new THREE.SphereGeometry(1.48, 32, 32);
    const coreMat = new THREE.MeshBasicMaterial({ 
      color: 0x030712, // Dark space background color
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    earthGroup.add(core);

    // 3. Kohima Target Dot (Precise Math Conversion)
    const targetGeo = new THREE.SphereGeometry(0.06, 16, 16);
    const targetMat = new THREE.MeshBasicMaterial({ color: 0x10b981 }); // Mint Green
    const target = new THREE.Mesh(targetGeo, targetMat);
    
    // Convert Lat/Lon to 3D Cartesian coordinates
    const R = 1.5;
    const latRad = TARGET_LAT * (Math.PI / 180);
    const lonRad = TARGET_LON * (Math.PI / 180);
    
    target.position.x = R * Math.cos(latRad) * Math.cos(lonRad);
    target.position.z = R * Math.cos(latRad) * Math.sin(-lonRad); // -lonRad aligns with standard 3D mapping
    target.position.y = R * Math.sin(latRad);
    
    globe.add(target); // Attach to globe so it rotates with the Earth

    // 4. Polar Orbit Ring
    const orbitGeo = new THREE.TorusGeometry(1.9, 0.004, 16, 100);
    const orbitMat = new THREE.MeshBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.6 });
    const orbit = new THREE.Mesh(orbitGeo, orbitMat);
    orbit.rotation.y = Math.PI / 2; // Polar trajectory
    scene.add(orbit);

    // 5. Active Satellite Tracker (Sentinel-2 Mockup)
    const satGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const satMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const satellite = new THREE.Mesh(satGeo, satMat);
    orbit.add(satellite); // Attach to orbit ring

    // Position Camera
    camera.position.z = 4.8;
    camera.position.y = 1.0; // Look slightly down at it
    camera.lookAt(0, 0, 0);

    // 6. Render & Animation Loop
    let animationFrameId: number;
    let satAngle = 0;

    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      
      // Rotate Earth slowly (Simulating rotation)
      globe.rotation.y += 0.003;

      // Orbit Satellite
      satAngle -= 0.02;
      satellite.position.x = Math.cos(satAngle) * 1.9;
      satellite.position.y = Math.sin(satAngle) * 1.9;

      renderer.render(scene, camera);
    };
    animate();

    // 7. Unmount Cleanup
    return () => {
      cancelAnimationFrame(animationFrameId);
      renderer.dispose();
      globeGeo.dispose();
      globeMat.dispose();
      coreGeo.dispose();
      coreMat.dispose();
      targetGeo.dispose();
      targetMat.dispose();
      orbitGeo.dispose();
      orbitMat.dispose();
      satGeo.dispose();
      satMat.dispose();
    };
  }, []);

  // --- MATH & DATA ENGINE (Runs every second) ---
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setTimeData({
        utcTime: now.toISOString().substring(11, 19) + ' UTC',
        localSolarTime: now.toLocaleTimeString('en-US', { hour12: false }) + ' LST',
      });

      const sunPosition = SunCalc.getPosition(now, TARGET_LAT, TARGET_LON);
      const altitudeDeg = sunPosition.altitude * (180 / Math.PI);
      const azimuthDeg = sunPosition.azimuth * (180 / Math.PI);
      const zenithDeg = 90 - altitudeDeg;
      const normalizedAzimuth = (azimuthDeg + 180) % 360;

      setSolarData({
        altitude: altitudeDeg.toFixed(2),
        zenith: zenithDeg.toFixed(2),
        azimuth: normalizedAzimuth.toFixed(2),
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // --- INLINE STYLES (Guarantees zero CSS errors) ---
  const styles: Record<string, React.CSSProperties> = {
    panel: {
      width: '200px', // Updated width to match new sidebar size
      backgroundColor: 'rgba(3, 7, 18, 0.85)',
      border: '1px solid #1a3a5a',
      padding: '20px',
      fontFamily: "'Space Mono', monospace",
      color: '#94a3b8',
      backdropFilter: 'none',
      boxSizing: 'border-box'
    },
    header: {
      color: '#0ea5e9',
      fontSize: '14px',
      fontWeight: 'bold',
      letterSpacing: '2px',
      borderBottom: '1px solid #1a3a5a',
      paddingBottom: '10px',
      marginBottom: '15px',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
    },
    pulse: {
      width: '8px',
      height: '8px',
      backgroundColor: '#10b981',
      borderRadius: '50%',
      boxShadow: '0 0 10px #10b981',
    },
    canvasContainer: {
      display: 'flex',
      justifyContent: 'center',
      marginBottom: '5px',
      height: '200px',
      width: '100%',
    },
    section: {
      marginBottom: '18px',
    },
    sectionTitle: {
      fontSize: '11px',
      color: '#475569',
      marginBottom: '8px',
      letterSpacing: '1px',
      textTransform: 'uppercase'
    },
    dataRow: {
      display: 'flex',
      justifyContent: 'space-between',
      marginBottom: '6px',
      fontSize: '13px',
    },
    label: {
      color: '#94a3b8',
    },
    value: {
      color: '#f8fafc',
      fontWeight: 'bold',
    },
    greenText: {
      color: '#10b981',
      fontWeight: 'bold',
    }
  };

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.pulse}></span>
        PLANETARY TELEMETRY
      </div>

      {/* 3D ENGINE MOUNTS HERE */}
      <div ref={mountRef} style={styles.canvasContainer} />

       <div style={styles.section}>
        <div style={styles.sectionTitle}>ORBITAL TIMEKEEPING</div>
        <TelemetryRow label="SYS UTC" value={timeData.utcTime} />
        <TelemetryRow label="TARGET LST" value={timeData.localSolarTime} />
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>SENSOR CALIBRATION (SUN)</div>
        <TelemetryRow label="SOLAR ZENITH" value={solarData.zenith} unit="°" />
        <TelemetryRow label="AZIMUTH (TRUE)" value={solarData.azimuth} unit="°" />
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>SPACE WEATHER / GNSS</div>
        <TelemetryRow label="GEOMAGNETIC K" value="2 (QUIET)" />
        <TelemetryRow label="GPS EST ERROR" value="< 1.5m" />
      </div>
    </div>
  );
};

export default PlanetaryTelemetry;
