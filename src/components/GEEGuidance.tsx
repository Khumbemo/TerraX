import React, { useState } from 'react';

const GEEGuidance = () => {
  const [activeStep, setActiveStep] = useState(0);

  const steps = [
    {
      title: "01. INITIALIZE ACCESS",
      content: "Navigate to code.earthengine.google.com. Ensure your Google account is authorized for Earth Engine. Create a new repository for your 'Forest-Capture' scripts.",
      code: "// No code needed for this step"
    },
    {
      title: "02. DEFINE BOUNDARIES",
      content: "Search for your study area (e.g., 'Kohima, Nagaland'). Use the Polygon Tool to draw your Area of Interest (AOI). Rename the import to 'roi'.",
      code: "var roi = ui.import && ui.import.roi;"
    },
    {
      title: "03. SELECT SATELLITE FEED",
      content: "Filter Sentinel-2 imagery for the best vegetation data. Choose a date range and filter for cloud cover below 10%.",
      code: "var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')\n  .filterBounds(roi)\n  .filterDate('2025-01-01', '2025-05-31')\n  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10));"
    },
    {
      title: "04. RENDER & CLIP",
      content: "Generate a median composite to remove transient shadows and clip it to your study area boundary.",
      code: "var median = s2.median().clip(roi);"
    },
    {
      title: "05. EXPORT FOR TERRASENSE",
      content: "Run the export script. The file will appear in your Google Drive as a .TIF. This is the file you upload to the dashboard.",
      code: "Export.image.toDrive({\n  image: median.select(['B4', 'B8']),\n  description: 'Kohima_S2_Data',\n  scale: 10,\n  region: roi\n});"
    }
  ];

  return (
    <div style={styles.container}>
      <h2 style={styles.header}>SYSTEM MANUAL: SATELLITE DATA EXTRACTION</h2>
      <p style={styles.subtext}>Follow these protocols to extract .TIF imagery from Google Earth Engine for analysis.</p>
      
      <div style={styles.stepWrapper}>
        <div style={styles.sidebar}>
          {steps.map((step, index) => (
            <button 
              key={index} 
              onClick={() => setActiveStep(index)}
              style={{
                ...styles.stepBtn,
                color: activeStep === index ? '#0ea5e9' : '#94a3b8',
                borderLeft: activeStep === index ? '2px solid #0ea5e9' : '2px solid #1a3a5a'
              }}
            >
              {step.title}
            </button>
          ))}
        </div>

        <div style={styles.contentArea}>
          <div style={styles.instructionCard}>
            <p style={styles.instructionText}>{steps[activeStep].content}</p>
            {steps[activeStep].code !== "// No code needed for this step" && (
              <pre style={styles.codeBlock}>
                <code>{steps[activeStep].code}</code>
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: '#030712',
    border: '1px solid #1a3a5a',
    padding: '20px',
    fontFamily: "'Space Mono', monospace",
    color: '#f8fafc',
    borderRadius: '4px',
    marginTop: '20px'
  },
  header: {
    fontSize: '18px',
    color: '#0ea5e9',
    letterSpacing: '2px',
    marginBottom: '10px'
  },
  subtext: {
    fontSize: '12px',
    color: '#94a3b8',
    marginBottom: '25px'
  },
  stepWrapper: {
    display: 'flex',
    gap: '20px',
    minHeight: '300px'
  },
  sidebar: {
    width: '200px',
    display: 'flex',
    flexDirection: 'column',
    gap: '5px'
  },
  stepBtn: {
    background: 'none',
    border: 'none',
    textAlign: 'left',
    padding: '10px',
    fontSize: '11px',
    cursor: 'pointer',
    transition: 'all 0.2s'
  },
  contentArea: {
    flex: 1,
    background: 'rgba(15, 23, 42, 0.5)',
    border: '1px solid #1a3a5a',
    padding: '20px',
    borderRadius: '4px'
  },
  instructionCard: {
    display: 'block'
  },
  instructionText: {
    fontSize: '14px',
    lineHeight: '1.6',
    color: '#e2e8f0',
    marginBottom: '15px'
  },
  codeBlock: {
    background: '#000',
    padding: '15px',
    borderRadius: '4px',
    fontSize: '12px',
    color: '#10b981',
    overflowX: 'auto',
    border: '1px solid #064e3b'
  }
};

export default GEEGuidance;
