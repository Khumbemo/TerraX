import React, { useState, useRef } from 'react';
import Papa from 'papaparse';
import * as GeoTIFF from 'geotiff';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import LocalChatbot from './LocalChatbot';

interface Metric {
  label: string;
  value: string | number;
}

interface ProcessedData {
  type: string;
  filename: string;
  size: string;
  metrics: Metric[];
  graphData: any[]; // Missing from my previous interface, added now
  targetMetric?: string;
  rawDataset?: any[]; // Added for dashboard
}

interface DataUploaderProps {
  onDataProcessed: (data: ProcessedData) => void;
}

const generateTifContext = (filename: string, width: number, height: number, bands: number) => {
  const name = filename.toLowerCase();
  let analysisType = "GENERIC RASTER ANALYSIS";
  let specificMetrics = [];

  if (name.includes('topography') || name.includes('dem') || name.includes('slope')) {
    analysisType = "TOPOGRAPHIC & DEM ANALYSIS";
    specificMetrics = [
      { label: 'ELEVATION MODEL', value: 'SRTM / ASTER' },
      { label: 'SLOPE GRADIENT', value: 'CALCULATED' }
    ];
  } else if (name.includes('fire') || name.includes('loss') || name.includes('hansen')) {
    analysisType = "DISTURBANCE & BURN SCAR TRACKING";
    specificMetrics = [
      { label: 'ANOMALY TYPE', value: 'FOREST LOSS / BURN' },
      { label: 'IMPACT SEVERITY', value: 'HIGH' }
    ];
  } else if (name.includes('population') || name.includes('nightlights')) {
    analysisType = "ANTHROPOGENIC FOOTPRINT";
    specificMetrics = [
      { label: 'URBAN DENSITY', value: 'MAPPED' },
      { label: 'LUMINOSITY INDEX', value: 'ACTIVE' }
    ];
  } else if (name.includes('sentinel') || name.includes('landsat')) {
    analysisType = "MULTISPECTRAL SATELLITE IMAGERY";
    specificMetrics = [
      { label: 'SENSOR', value: name.includes('sentinel') ? 'SENTINEL-2' : 'LANDSAT-8' },
      { label: 'TRUE COLOR', value: 'RGB RENDERED' }
    ];
  }

  return { analysisType, specificMetrics };
};

const DataUploader: React.FC<DataUploaderProps> = ({ onDataProcessed }) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [report, setReport] = useState<ProcessedData | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const processFile = async (file: File) => {
    setIsProcessing(true);
    const ext = file.name.split('.').pop()?.toLowerCase();
    const size = (file.size / (1024 * 1024)).toFixed(2);

    await new Promise(res => setTimeout(res, 1200)); // Cinematic delay

    try {
      if (ext === 'csv') {
        Papa.parse(file, {
          header: true,
          dynamicTyping: true,
          skipEmptyLines: true,
          complete: (results: any) => {
            const data = results.data;
            const keys = Object.keys(data[0] || {});
            
            const yAxisKey = 
              // Vegetation
              keys.find(k => k.toLowerCase().includes('ndvi')) ||
              keys.find(k => k.toLowerCase().includes('evi')) ||
              keys.find(k => k.toLowerCase().includes('canopy')) ||
              // Climate & Weather
              keys.find(k => k.toLowerCase().includes('precip')) ||
              keys.find(k => k.toLowerCase().includes('rain')) ||
              keys.find(k => k.toLowerCase().includes('lst')) || // Land Surface Temp
              keys.find(k => k.toLowerCase().includes('temp')) ||
              keys.find(k => k.toLowerCase().includes('evapo')) || // Evapotranspiration
              keys.find(k => k.toLowerCase().includes('solar')) || // Solar Radiation
              keys.find(k => k.toLowerCase().includes('rad')) ||
              // Carbon / Soil
              keys.find(k => k.toLowerCase().includes('carbon')) ||
              keys.find(k => k.toLowerCase().includes('agb')) || // Above Ground Biomass
              // Generic Fallback
              keys.find(k => typeof data[0][k] === 'number' && !k.toLowerCase().includes('id') && !k.toLowerCase().includes('year')) ||
              keys[1];
            
            if (!yAxisKey) {
              alert("SYSTEM ALERT: Could not identify a valid telemetry metric in this file.");
              setIsProcessing(false);
              return;
            }
            
            const xAxisKey = keys.find(k => k.toLowerCase().includes('date') || k.toLowerCase().includes('time') || k.toLowerCase().includes('year')) || 
                             keys.find(k => typeof data[0][k] === 'string') || 
                             keys[0];

            let sum = 0, min = 9999, max = -9999;
            const chartData = data.map((row: any, i: number) => {
              const val = row[yAxisKey];
              if (typeof val === 'number') {
                sum += val;
                if (val < min) min = val;
                if (val > max) max = val;
              }
              return { name: row[xAxisKey] || `Pt ${i}`, value: val };
            }).slice(0, 100);

            onDataProcessed({
              type: 'CSV_SERIES',
              filename: file.name,
              size: `${size} MB`,
              targetMetric: yAxisKey, // Use actual key for data lookup
              metrics: [
                { label: 'RECORDS', value: data.length },
                { label: 'PEAK VALUE', value: max.toFixed(3) },
                { label: 'MEAN VALUE', value: (sum / data.length).toFixed(3) }
              ],
              graphData: chartData,
              rawDataset: data
            });
            setReport({
              type: 'CSV_SERIES',
              filename: file.name,
              size: `${size} MB`,
              targetMetric: yAxisKey,
              metrics: [
                { label: 'RECORDS', value: data.length },
                { label: 'PEAK VALUE', value: max.toFixed(3) },
                { label: 'MEAN VALUE', value: (sum / data.length).toFixed(3) }
              ],
              graphData: chartData,
              rawDataset: data
            });
            setIsProcessing(false);
          }
        });
      } else if (ext === 'tif' || ext === 'tiff') {
        const tiff = await GeoTIFF.fromBlob(file);
        const image = await tiff.getImage();
        const width = image.getWidth();
        const height = image.getHeight();
        const bands = image.getSamplesPerPixel();
        
        // Call our new Context Injector
        const tifContext = generateTifContext(file.name, width, height, bands);

        const rasters = await image.readRasters({ width: 100, height: 100 }); 
        const pixels = rasters[0] as any;
        
        const bins = Array(20).fill(0);
        let min = Infinity, max = -Infinity;
        pixels.forEach((p: number) => { if(p < min) min = p; if(p > max) max = p; });
        const binSize = (max - min) / 20;
        
        pixels.forEach((p: number) => {
          const binIndex = Math.min(Math.floor((p - min) / binSize), 19);
          bins[binIndex]++;
        });

        const chartData = bins.map((count: number, i: number) => ({
          name: `Intensity ${(min + (i * binSize)).toFixed(1)}`,
          count: count
        }));

        const finalReport = {
          type: 'TIF_RASTER',
          filename: file.name,
          size: `${size} MB`,
          targetMetric: tifContext.analysisType, // Adds the cool title to the graph!
          metrics: [
            { label: 'RESOLUTION', value: `${width}x${height}` },
            { label: 'SPECTRAL BANDS', value: bands },
            { label: 'PIXEL RANGE', value: `${min.toFixed(0)} - ${max.toFixed(0)}` },
            ...tifContext.specificMetrics // Injects the specialized data based on filename!
          ],
          graphData: chartData
        };

        onDataProcessed(finalReport);
        setReport(finalReport);
        setIsProcessing(false);
      }
    } catch (err) {
      console.error(err);
      alert("ERROR PARSING FILE.");
      setIsProcessing(false);
    }
  };

  const handleSaveReport = () => {
    if (!report) return;
    
    // Create a JSON blob of the report data
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(report, null, 2));
    
    // Create a hidden download link and click it
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `TERRASENSE_EXPORT_${report.filename}.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const loadPreloaded = async (fileName: string) => {
    setIsProcessing(true);
    try {
      const response = await fetch(`/${fileName}`);
      if (!response.ok) throw new Error("Failed to fetch internal repository");
      const blob = await response.blob();
      const file = new File([blob], fileName, { type: 'text/csv' });
      processFile(file);
    } catch (err) {
      console.error(err);
      alert("LOCAL REPOSITORY ACCESS DENIED.");
      setIsProcessing(false);
    }
  };

  return (
    <div className="uploader-container">
      <div 
        className={`upload-zone ${dragActive ? 'active' : ''} ${isProcessing ? 'processing' : ''}`}
        onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}
        onClick={() => !isProcessing && fileInputRef.current?.click()}
      >
        <input ref={fileInputRef} type="file" accept=".csv, .tif, .tiff" style={{ display: 'none' }} onChange={(e) => e.target.files && processFile(e.target.files[0])} />
        
        {!isProcessing ? (
          <>
            <span className="upload-icon">[ ↓ ]</span>
            <p>DRAG & DROP TELEMETRY (.CSV / .TIF)</p>
          </>
        ) : (
          <div className="processing-state">
            <div className="scanner-line"></div>
            <p>EXTRACTING MULTISPECTRAL DATA...</p>
          </div>
        )}
      </div>

      <div className="quick-load-repository" style={{ marginTop: '15px' }}>
        <div style={{ color: '#5a8aaa', fontSize: '10px', marginBottom: '8px', letterSpacing: '1px' }}>INTERNAL REPOSITORIES:</div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {[
            { id: 'ndvi', file: 'ndvi_data.csv', label: 'VEGETATION (NDVI/EVI)' },
            { id: 'lst', file: 'lst_data.csv', label: 'SURFACE TEMP (LST)' },
            { id: 'precip', file: 'precipitation_data.csv', label: 'RAINFALL (PRECIP)' },
            { id: 'temp', file: 'temp_humidity_data.csv', label: 'TEMP & HUMIDITY' },
            { id: 'evap', file: 'evapotranspiration_data.csv', label: 'EVAPOTRANSPIRATION' },
            { id: 'solar', file: 'solar_radiation_data.csv', label: 'SOLAR RADIATION' }
          ].map(repo => (
            <button 
              key={repo.id}
              onClick={(e) => { e.stopPropagation(); loadPreloaded(repo.file); }}
              style={{
                background: 'rgba(26, 58, 90, 0.4)',
                border: '1px solid #1a3a5a',
                color: '#5ab0f0',
                padding: '6px 12px',
                fontSize: '10px',
                borderRadius: '4px',
                cursor: 'pointer',
                fontFamily: 'Space Mono'
              }}
            >
              LOAD: {repo.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default DataUploader;
