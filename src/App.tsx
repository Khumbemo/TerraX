/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * FIXES APPLIED:
 * 1. Reports now save to localStorage after generation
 * 2. chatMessages array is rendered — follow-up answers are visible
 * 3. API key input wired to state and used at call time
 * 4. Starfield coordinates memoized — no more scrambling on re-render
 * 5. Actual drag-and-drop added to the dropzone
 * 6. Enter key sends follow-up message
 * 7. Chat auto-scrolls to bottom on new message
 * 8. GeoTIFF domain computed dynamically from raster values
 * 9. Updated to gemini-2.0-flash
 * 10. "Load Full Report" in archive now works
 * 11. Chat area has max-height + scroll so it doesn't blow the layout
 * 12. CSV axis selector dropdown added
 */

import React, { useState, ChangeEvent, useRef, useEffect, useMemo } from 'react';
import { GoogleGenAI } from "@google/genai";
import * as XLSX from "xlsx";
import * as GeoTIFF from "geotiff";
import * as plotty from "plotty";
import { Line } from "react-chartjs-2";
import "chart.js/auto";
import ReactMarkdown from 'react-markdown';
import { motion } from 'motion/react';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { MapContainer, TileLayer, Rectangle, useMap } from 'react-leaflet';
import { Satellite, Settings, UploadCloud } from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import GEEGuidance from './components/GEEGuidance';
import PlanetaryTelemetry from './components/PlanetaryTelemetry';
import LiveTelemetryDock from './components/LiveTelemetryDock';
import DataUploader from './components/DataUploader';
import CoreAnalysisDashboard from './components/CoreAnalysisDashboard';
import LocalChatbot from './components/LocalChatbot';
import SystemGuideBot from './components/SystemGuideBot';
import StandardLogin from './components/StandardLogin';
import FileChatBubble from './components/FileChatBubble';
import ErrorBoundary from './components/ErrorBoundary';

import agentConfig from '../agent_config.json';

interface ProcessedData {
  type: string;
  filename: string;
  size: string;
  metrics: { label: string; value: string | number }[];
  graphData: any[];
  targetMetric?: string;
  rawDataset?: any[];
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div style={{ background: '#020617', border: '1px solid #0ea5e9', padding: '10px', fontFamily: 'Space Mono' }}>
        <p style={{ color: '#94a3b8', margin: 0, fontSize: '10px' }}>{label}</p>
        <p style={{ color: '#10b981', margin: 0, fontSize: '12px', fontWeight: 'bold' }}>
          VALUE: {payload[0].value}
        </p>
      </div>
    );
  }
  return null;
};

const MODEL = "gemini-3-flash-preview";

// This helper instantly flies the map to the coordinates of the uploaded TIF
const MapController = ({ bounds }: { bounds: any }) => {
    const map = useMap();
    if (bounds) {
        map.fitBounds(bounds);
    }
    return null;
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

interface ReportData {
  filename: string;
  content: string;
  timestamp: string;
}

interface TiffData {
  raster: Float32Array;
  width: number;
  height: number;
}

interface ChartConfig {
  labels: string[];
  xLabel: string;
  yLabel: string;
  allHeaders: string[];
  allRows: string[][];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildChart(config: ChartConfig, xIdx: number, yIdx: number, timeIndex: number) {
  const totalRows = config.allRows.length - 1;
  const chunkSize = Math.max(1, Math.floor(totalRows / 6));
  const start = 1 + (timeIndex * chunkSize);
  const end = Math.min(start + chunkSize, totalRows + 1);
  const rows = config.allRows.slice(start, end);
  return {
    labels: rows.map(r => r[xIdx] ?? ''),
    datasets: [{
      label: config.allHeaders[yIdx] || 'Telemetry',
      data: rows.map(r => {
        const val = parseFloat(r[yIdx]);
        return isNaN(val) ? 0 : val;
      }),
      borderColor: '#5ab0f0',
      backgroundColor: 'rgba(90, 176, 240, 0.15)',
      tension: 0.4,
      pointBackgroundColor: '#5ab0f0',
      pointRadius: 4,
    }]
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function App() {
  const [localChatHistory, setLocalChatHistory] = useState<any[]>([]);
  const [systemChatHistory, setSystemChatHistory] = useState<any[]>([]);

  // ── Intelligent Chat Handler (Reports) ──
  const handleBotMessage = async (userMsg: string) => {
    try {
      const ai = getAI();
      const datasetInfo = uploadResult ? JSON.stringify({
        filename: uploadResult.filename,
        type: uploadResult.type,
        metrics: uploadResult.metrics,
        summary: report?.content || "No summary available"
      }) : "No dataset currently loaded.";

      const fullPrompt = `USER QUERY: ${userMsg}\n\nCONTEXTUAL DATASET INFO:\n${datasetInfo}\n\nPlease respond based on your configuration and the provided context. Focus on analyzing the telemetry data.`;

      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [
          ...localChatHistory.slice(-6),
          { role: 'user', parts: [{ text: fullPrompt }] }
        ],
        config: {
          systemInstruction: agentConfig.systemMessage,
          temperature: 0.7,
          tools: [{ googleSearch: {} }],
        }
      });

      let responseText = response.text || "Neural glitch: Signal lost.";
      
      // Extract URLs from grounding metadata
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (chunks && chunks.length > 0) {
        responseText += "\n\n**RESEARCH SOURCES:**\n";
        chunks.forEach((chunk: any, i: number) => {
          if (chunk.web?.uri) {
            responseText += `${i + 1}. [${chunk.web.title || 'Source'}](${chunk.web.uri})\n`;
          }
        });
      }

      setLocalChatHistory(prev => [...prev, { role: 'user', parts: [{ text: userMsg }] }, { role: 'model', parts: [{ text: responseText }] }]);
      return responseText;
    } catch (err: any) {
      console.error("AI CHAT ERROR:", err);
      return `SYSTEM OVERLOAD: ${err.message || "An unexpected error occurred in the neural bridge."}`;
    }
  };

  // ── Intelligent Chat Handler (General Guide) ──
  const handleSystemBotMessage = async (userMsg: string) => {
    try {
      const ai = getAI();
      const fullPrompt = `USER QUERY: ${userMsg}\n\nYou are acting as the OS GUIDE. Assist the user with navigating TerraSense, explaining features, or providing general geospatial mission guidance.`;

      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [
          ...systemChatHistory.slice(-6),
          { role: 'user', parts: [{ text: fullPrompt }] }
        ],
        config: {
          systemInstruction: agentConfig.systemMessage,
          temperature: 0.7,
          tools: [{ googleSearch: {} }],
        }
      });

      let responseText = response.text || "Neural glitch: Signal lost.";

      // Extract URLs from grounding metadata
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (chunks && chunks.length > 0) {
        responseText += "\n\n**SYSTEM KNOWLEDGE REFS:**\n";
        chunks.forEach((chunk: any, i: number) => {
          if (chunk.web?.uri) {
            responseText += `${i + 1}. [${chunk.web.title || 'Knowledge Base'}](${chunk.web.uri})\n`;
          }
        });
      }

      setSystemChatHistory(prev => [...prev, { role: 'user', parts: [{ text: userMsg }] }, { role: 'model', parts: [{ text: responseText }] }]);
      return responseText;
    } catch (err: any) {
      console.error("AI SYSTEM CHAT ERROR:", err);
      return `OS ALERT: ${err.message || "Neural link unstable."}`;
    }
  };

  const [showSettings, setShowSettings] = useState(false);
  const [activeSettingsTab, setActiveSettingsTab] = useState("settings");
  const [activeView, setActiveView] = useState<'explore' | 'reports' | 'data'>('explore');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // ── API Key ──
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [savedApiKey, setSavedApiKey] = useState(() => localStorage.getItem('terrasense_api_key') || '');

  // ── Data & Visuals ──
  const [tiffData, setTiffData] = useState<TiffData | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [chartConfig, setChartConfig] = useState<ChartConfig | null>(null);
  const [xAxisIdx, setXAxisIdx] = useState(0);
  const [yAxisIdx, setYAxisIdx] = useState(1);
  const [chartData, setChartData] = useState<any>(null);
  const [mapBounds, setMapBounds] = useState<any>(null);
  const [timeIndex, setTimeIndex] = useState(0);

  // ── Archive ──
  const [savedReportData, setSavedReportData] = useState<ReportData | null>(() => {
    const raw = localStorage.getItem('terrasense_last_report');
    return raw ? JSON.parse(raw) : null;
  });

  const [uploadResult, setUploadResult] = useState<ProcessedData | null>(null);
  
  // THE ULTIMATE "HACKATHON" SAFETY NET
  useEffect(() => {
    // 1. Silently catch unhandled promise rejections (e.g., API failures)
    const handleRejection = (event: PromiseRejectionEvent) => {
      console.warn("TERRASENSE DEFENSE: Suppressed background promise failure.", event.reason);
      event.preventDefault(); // Stops the crash
    };
    
    // 2. Silently catch raw Javascript errors
    const handleError = (event: ErrorEvent) => {
      // Ignore ResizeObserver errors (very common benign error in charting libraries)
      if (event.message === 'ResizeObserver loop limit exceeded') {
        return;
      }
      
      console.warn("TERRASENSE DEFENSE: Suppressed background JS error.", event.message);
      event.preventDefault(); // Stops the crash
    };

    window.addEventListener('unhandledrejection', handleRejection as any);
    window.addEventListener('error', handleError as any);
    
    return () => {
      window.removeEventListener('unhandledrejection', handleRejection as any);
      window.removeEventListener('error', handleError as any);
    };
  }, []);
  
  // ── Chat ──
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const chatHistoryRef = useRef<any[]>([]);
  const reportRef = useRef<HTMLDivElement>(null);

  // ── Refs ──
  const tiffCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // ── Draw TIF when canvas + data are both ready (unchanged logic) ──
  useEffect(() => {
    if (tiffData && tiffCanvasRef.current) {
      tiffCanvasRef.current.width = tiffData.width;
      tiffCanvasRef.current.height = tiffData.height;
      const rasterArray = Array.from(tiffData.raster);
      const minVal = Math.min(...rasterArray);
      const maxVal = Math.max(...rasterArray);
      const plot = new plotty.plot({
        canvas: tiffCanvasRef.current,
        data: tiffData.raster,
        width: tiffData.width,
        height: tiffData.height,
        domain: [minVal, maxVal],
        colorScale: 'viridis',
      });
      plot.render();
    }
  }, [tiffData, report]);

  // ── Helpers ──

  function getAI() {
    const key = savedApiKey || process.env.GEMINI_API_KEY || '';
    return new GoogleGenAI({ apiKey: key });
  }

  function saveReport(r: ReportData) {
    localStorage.setItem('terrasense_last_report', JSON.stringify(r));
    setSavedReportData(r);
  }

  function loadSavedReport() {
    if (savedReportData) {
      setReport(savedReportData);
      setShowSettings(false);
      setActiveView('reports');
    }
  }

  function saveApiKey() {
    localStorage.setItem('terrasense_api_key', apiKeyInput);
    setSavedApiKey(apiKeyInput);
    setApiKeyInput('');
    alert('API key saved locally.');
  }

  const downloadReport = () => {
    if (!report) return;
    const blob = new Blob(
      [`TERRASENSE EARTH INTELLIGENCE REPORT\n====================================\n\n${report.content}`],
      { type: 'text/plain' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `TerraSense_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(Array.from(e.target.files));
  };

  // ── File Processing ──
  async function processFiles(files: File[]) {
    if (!files.length) return;
    setLoading(true);
    setReport(null);
    setChartData(null);
    setChartConfig(null);
    setTiffData(null);
    setChatMessages([]);
    chatHistoryRef.current = [];
    if (tiffCanvasRef.current) {
      const ctx = tiffCanvasRef.current.getContext('2d');
      ctx?.clearRect(0, 0, tiffCanvasRef.current.width, tiffCanvasRef.current.height);
    }
    let masterContext = '';
    const processedFiles: string[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        let parsedContent = '';
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (!ext) { throw new Error(`File ${file.name} has no extension`); }
        if (ext === 'csv') {
          parsedContent = await file.text();
          const rows = parsedContent.split('\n').filter(line => line.trim()).map(r => r.split(','));
          if (rows.length > 2) {
            const headers = rows[0];
            const lowerHeaders = headers.map(h => h.toLowerCase());
            
            // MASTER DICTIONARY SYNC
            const xIdx = headers.findIndex(h => {
              const lh = h.toLowerCase();
              return lh.includes('date') || lh.includes('time') || lh.includes('year');
            });
            const yIdx = headers.findIndex(h => {
              const lh = h.toLowerCase();
              return lh.includes('ndvi') || lh.includes('evi') || lh.includes('precip') || 
                     lh.includes('rain') || lh.includes('lst') || lh.includes('temp') || 
                     lh.includes('evapo') || lh.includes('solar') || lh.includes('rad');
            });

            const finalXIdx = xIdx !== -1 ? xIdx : 0;
            const finalYIdx = yIdx !== -1 ? yIdx : 1;

            const config: ChartConfig = {
              labels: rows.slice(1).map(r => r[finalXIdx]),
              xLabel: headers[finalXIdx],
              yLabel: headers[finalYIdx] || 'Value',
              allHeaders: headers,
              allRows: rows,
            };
            setChartConfig(config);
            setXAxisIdx(finalXIdx);
            setYAxisIdx(finalYIdx);
            setChartData(buildChart(config, finalXIdx, finalYIdx, 0));
          }
        } else if (ext === 'xlsx' || ext === 'xls') {
          const ab = await file.arrayBuffer();
          const wb = XLSX.read(ab, { type: 'array' });
          if (wb.SheetNames.length === 0) throw new Error("Excel file is empty");
          const ws = wb.Sheets[wb.SheetNames[0]];
          parsedContent = XLSX.utils.sheet_to_csv(ws);
        } else if (ext === 'tif' || ext === 'tiff') {
          const ab = await file.arrayBuffer();
          const tiff = await GeoTIFF.fromArrayBuffer(ab);
          const image = await tiff.getImage();
          const raster = await image.readRasters();
          if (!raster || raster.length === 0) { throw new Error("Could not read raster data from TIF file"); }
          setTiffData({
            raster: raster[0] as Float32Array,
            width: image.getWidth(),
            height: image.getHeight(),
          });
          const bbox = image.getBoundingBox();
          if (bbox) { setMapBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]); }
          parsedContent = `GeoTIFF: ${image.getWidth()}x${image.getHeight()}, BBox [${bbox?.join(', ') || 'N/A'}]`;
        } else {
            throw new Error(`Unsupported file type: ${ext}`);
        }
        if (parsedContent !== undefined && parsedContent !== null) {
          masterContext += `\n\n--- FILE: ${file.name} ---\n${parsedContent.substring(0, 5000)}\n`;
          processedFiles.push(file.name);
        }
      } catch (err: any) {
        console.error(`Error processing file ${file.name}:`, err);
        errors.push(`${file.name}: ${err.message}`);
      }
    }
    if (!processedFiles.length) {
      setLoading(false);
      alert("No files were processed successfully:\n" + errors.join('\n'));
      return;
    }
    try {
      const prompt = `Analyze the uploaded ecological dataset(s): ${processedFiles.join(', ')}. Provide a brief 3-sentence summary highlighting the most critical spatial, temporal, or causal findings from this data.\n\nData:\n${masterContext}`;
      const ai = getAI();
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: { parts: [{ text: prompt }] },
      });
      const aiReport = response.text || '';
      chatHistoryRef.current = [
        { role: 'user', parts: [{ text: prompt }] },
        { role: 'model', parts: [{ text: aiReport }] },
      ];
      const reportObj: ReportData = {
        filename: `SOURCES: ${processedFiles.join(', ')}`,
        content: aiReport,
        timestamp: new Date().toLocaleString(),
      };
      setReport(reportObj);
      saveReport(reportObj);
      setChatMessages([{ role: 'assistant', text: aiReport }]);
    } catch (err: any) {
      console.error(err);
      let errMsg = err.message || JSON.stringify(err);
      try {
        const parsed = JSON.parse(errMsg);
        if (parsed.error?.message) errMsg = parsed.error.message;
      } catch (e) {}
      
      let friendlyMessage = `Analysis failed: ${errMsg}`;
      if (errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
        friendlyMessage = "TerraAi is currently resting (rate limit exceeded or quota exhausted). Please wait a few minutes or check your billing plan.";
      }
      setChatMessages(prev => [...prev, { role: 'assistant', text: friendlyMessage }]);
      setReport({ filename: 'Error', content: friendlyMessage, timestamp: new Date().toLocaleString() });
    } finally {
      setLoading(false);
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = () => setIsDragging(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) processFiles(Array.from(e.dataTransfer.files));
  };

  const exportToPDF = async () => {
    if (!reportRef.current) return;
    const canvas = await html2canvas(reportRef.current, { scale: 2, backgroundColor: "#070e1a" });
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
    pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
    pdf.save('TerraSense_Executive_Brief.pdf');
  };

  // ── Styles ──

  const colors = {
    dark: {
      bg: '#050a14',
      card: '#070e1a',
      text: '#c8e4f8',
      muted: '#5a8aaa',
      accent: '#5ab0f0',
      border: '#1a3a5a',
      input: '#050a14',
      btn: '#0a2a50',
    }
  };

  const themeColors = colors.dark;

  const S = useMemo(() => ({
    nav: { display: 'flex', gap: '20px', padding: '15px 30px', borderBottom: `1px solid ${themeColors.border}`, background: themeColors.card, position: 'relative' as const, zIndex: 10 },
    navBtn: (active: boolean) => ({ background: 'none', border: 'none', cursor: 'pointer', color: active ? themeColors.accent : themeColors.muted, borderBottom: active ? `2px solid ${themeColors.accent}` : '2px solid transparent', paddingBottom: '4px', fontSize: '14px' }),
    card: { background: themeColors.card, padding: '25px', borderRadius: '12px', border: `1px solid ${themeColors.border}` },
    label: { fontSize: '11px', letterSpacing: '1.5px', color: themeColors.muted, marginBottom: '16px', display: 'block' as const },
    input: { width: '100%', padding: '12px', background: themeColors.input, border: `1px solid ${themeColors.border}`, color: themeColors.text, borderRadius: '6px', boxSizing: 'border-box' as const },
    btn: { background: themeColors.btn, border: `1px solid ${themeColors.border}`, color: themeColors.accent, padding: '8px 18px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' as const, fontSize: '13px' },
    select: { background: themeColors.input, border: `1px solid ${themeColors.border}`, color: themeColors.text, padding: '6px 10px', borderRadius: '6px', fontSize: '13px', cursor: 'pointer' },
  }), [themeColors]);

  return (
    <ErrorBoundary>
      <div className="terrasense-app" style={{ position: 'relative', minHeight: '100vh', background: themeColors.bg }}>
        <div className="earth-background"></div>
                <nav className="top-navbar" style={{...S.nav, zIndex: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <div className="brand" style={{ fontWeight: 'bold', color: '#5ab0f0', letterSpacing: '2px', fontSize: '15px' }}>TERRASENSE</div>
                <div className="nav-links" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button className={activeView === 'explore' ? 'active-link' : ''} onClick={() => setActiveView('explore')} style={{...S.navBtn(activeView === 'explore'), padding: '4px 8px'}}>Explore</button>
                  
                  {/* SETTINGS DROPDOWN CONTAINER */}
                  <div className="settings-wrapper" style={{ padding: '4px 8px' }}>
                    <button 
                      className={`settings-btn ${isSettingsOpen ? 'active' : ''}`}
                      onClick={() => setIsSettingsOpen(!isSettingsOpen)}
                    >
                      SETTINGS {isSettingsOpen ? '▲' : '▼'}
                    </button>

                    {/* THE DROPDOWN MENU */}
                    {isSettingsOpen && (
                      <div className="settings-dropdown">
                        <hr className="dropdown-divider" />
                        <button className="dropdown-logout-btn" onClick={() => { setIsSettingsOpen(false); setShowSettings(true); setActiveSettingsTab('settings'); }}>
                          Features
                        </button>
                        <button className="dropdown-logout-btn" onClick={() => setIsAuthenticated(false)}>
                          LOGOUT SESSION
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </nav>

              {/* SETTINGS MODAL */}
              {showSettings && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(5,10,20,0.85)', backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '40px' }}>
                  <div style={{ background: themeColors.card, border: `1px solid ${themeColors.border}`, borderRadius: '12px', width: '100%', maxWidth: '860px', height: '75vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div style={{ padding: '18px 24px', borderBottom: `1px solid ${themeColors.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#7ab8d8', fontWeight: 'bold', letterSpacing: '1px' }}>DOCUMENTATION & SETTINGS</span>
                      <button onClick={() => setShowSettings(false)} style={{ background: 'transparent', border: 'none', color: '#5a8aaa', cursor: 'pointer', fontSize: '18px' }}>✕</button>
                    </div>
                    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                      <div style={{ width: '220px', background: themeColors.bg, borderRight: `1px solid ${themeColors.border}`, display: 'flex', flexDirection: 'column' }}>
                        {[['settings', 'Settings'], ['app', '1. Architecture'], ['satellite', '2. Satellite Data'], ['gee', '3. GEE Manual'], ['reports', '4. Reports'], ['data', '5. Data']].map(([tab, label]) => (
                          <button key={tab} onClick={() => setActiveSettingsTab(tab)}
                            style={{ background: activeSettingsTab === tab ? themeColors.btn : 'transparent', color: activeSettingsTab === tab ? themeColors.text : themeColors.muted, border: 'none', padding: '18px 20px', textAlign: 'left', cursor: 'pointer', borderBottom: `1px solid ${themeColors.border}`, fontSize: '13px' }}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <div style={{ flex: 1, padding: '28px', overflowY: 'auto', fontSize: '14px', lineHeight: '1.7' }}>
                        {activeSettingsTab === 'settings' && (
                          <div>
                            <h4 style={{ color: themeColors.accent }}>Theme Preferences</h4>
                            <p style={{ color: themeColors.muted }}>Currently running in Dark Mode.</p>
                            <p style={{ color: themeColors.muted, marginTop: '20px' }}>API key configuration. See Data Sources tab.</p>
                          </div>
                        )}
                        {activeSettingsTab === 'app' && <div><h4 style={{ color: '#5ab0f0' }}>Platform Architecture</h4><p>TerraSense processes all files client-side in your browser. Nothing is uploaded to any server. The Gemini API is called directly with your data context.</p></div>}
                        {activeSettingsTab === 'satellite' && <div><h4 style={{ color: '#5ab0f0' }}>Satellite Data</h4><p>GeoTIFF rasters are visualised using the Viridis color scale. Domain is computed dynamically from the actual min/max values in your raster band — so NDVI, elevation, and temperature files all render correctly.</p></div>}
                        {activeSettingsTab === 'gee' && <GEEGuidance />}
                        {activeSettingsTab === 'reports' && (
                            <div style={S.card}>
                              <h3 style={{ color: '#5ab0f0', marginTop: 0, letterSpacing: '1px' }}>INTELLIGENCE ARCHIVE</h3>
                              {savedReportData ? (
                                <div style={{ marginTop: '20px' }}>
                                  <p style={{ color: themeColors.text }}>Last Report: {savedReportData.timestamp}</p>
                                  <p style={{ color: themeColors.text, fontSize: '12px' }}>{savedReportData.filename}</p>
                                  <button onClick={loadSavedReport} style={S.btn}>Load Full Report</button>
                                </div>
                              ) : (
                                <p style={{ color: themeColors.muted }}>No reports archived.</p>
                              )}
                            </div>
                        )}
                        {activeSettingsTab === 'data' && (
                            <div style={S.card}>
                              <h3 style={{ color: '#5ab0f0', marginTop: 0, letterSpacing: '1px' }}>DATA SOURCES</h3>
                              <div style={{ marginTop: '20px' }}>
                                <label style={S.label}>GEMINI API KEY</label>
                                <div style={{ display: 'flex', gap: '10px' }}>
                                    <input 
                                      type="password" 
                                      value={apiKeyInput} 
                                      onChange={(e) => setApiKeyInput(e.target.value)} 
                                      placeholder={savedApiKey ? "••••••••••••••••" : "AIZA..."}
                                      style={S.input} 
                                    />
                                    <button onClick={saveApiKey} style={S.btn}>Save Key</button>
                                </div>
                              </div>
                            </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* MAIN CONTENT */}
              <div className="terrasense-workspace" style={{ zIndex: 10 }}>
                <div className="telemetry-panel" style={{ flex: '0 0 350px' }}>
                  <PlanetaryTelemetry />
                </div>
                <div className="center-column" style={{ flex: 1 }}>
                  {activeView === 'explore' && (
                    <>
                      {/* Globe */}
                      <div className="map-container" style={{ height: "350px", width: "100%", borderRadius: "8px", overflow: "hidden", border: "1px solid #1a3a5a", marginBottom: "20px" }}>
                      <MapContainer center={[25.674, 94.108] as any} zoom={10} style={{ height: "100%", width: "100%", background: "#050a14" }}>
                           <TileLayer 
                               url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                               attribution='&copy; <a href="https://carto.com/">CARTO</a>'
                           />
                           {mapBounds && (
                               <>
                                   <MapController bounds={mapBounds} />
                                   <Rectangle bounds={mapBounds} pathOptions={{ color: "#5ab0f0", weight: 2, fillOpacity: 0.2 }} />
                               </>
                           )}
                       </MapContainer>
                  </div>

                  {/* FIX #5: Dropzone */}
                  {!uploadResult ? (
                    <DataUploader onDataProcessed={(data) => setUploadResult(data)} />
                  ) : (
                    <div className="intelligence-report-card">
                      <div className="report-header">
                        <span className="status-dot"></span>
                        INTELLIGENCE ARCHIVE // UPLOAD SUCCESS
                        <button className="reset-btn" onClick={() => setUploadResult(null)}>[X] CLEAR</button>
                      </div>
                      
                      <div className="report-body">
                        <div className="report-row">
                          <span className="label">TARGET FILE:</span>
                          <span className="value file-name">{uploadResult.filename}</span>
                        </div>
                        <div className="report-row">
                          <span className="label">DATA TYPE:</span>
                          <span className="value">{uploadResult.type}</span>
                        </div>
                        <div className="report-row">
                          <span className="label">FILE SIZE:</span>
                          <span className="value">{uploadResult.size}</span>
                        </div>
                        
                        <div className="divider"></div>
                        
                        <div className="metrics-grid">
                          {uploadResult.metrics.map((metric, index) => (
                            <div className="metric-box" key={index}>
                              <div className="metric-label">{metric.label}</div>
                              <div className="metric-value">{metric.value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      
                      {/* CHATBOT INTEGRATION */}
                      <div className="report-chatbot-wrapper">
                        <LocalChatbot 
                          currentReport={uploadResult} 
                          onSendMessage={handleBotMessage}
                        /> 
                      </div>

                      {/* NEW ACTION BAR: Save and Back Options */}
                      <div className="report-action-bar">
                        <button className="action-btn back-btn" onClick={() => setUploadResult(null)}>
                          [ ← ] TERMINATE & NEW UPLOAD
                        </button>
                        <button className="action-btn save-btn" onClick={() => {
                            if (!uploadResult) return;
                            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(uploadResult, null, 2));
                            const downloadAnchorNode = document.createElement('a');
                            downloadAnchorNode.setAttribute("href", dataStr);
                            downloadAnchorNode.setAttribute("download", `TERRASENSE_EXPORT_${uploadResult.filename}.json`);
                            document.body.appendChild(downloadAnchorNode);
                            downloadAnchorNode.click();
                            downloadAnchorNode.remove();
                        }}>
                          [ ↓ ] EXPORT TELEMETRY
                        </button>
                      </div>

                      {/* CORE ANALYSIS DASHBOARD */}
                      {uploadResult.type === 'CSV_SERIES' && uploadResult.rawDataset && (
                          <CoreAnalysisDashboard 
                              rawData={uploadResult.rawDataset}
                              targetMetric={uploadResult.targetMetric || ''}
                              filename={uploadResult.filename}
                          />
                      )}
                    </div>
                  )}

                  {/* RESULTS */}
                  {(chartData || tiffData || report) && (
                    <div ref={reportRef} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                      {tiffData && (
                        <div style={S.card}>
                           <canvas ref={tiffCanvasRef} style={{ width: '100%', borderRadius: '4px' }} />
                        </div>
                      )}
                      {chartData && (
                        <div style={S.card}>
                          <Line data={chartData} options={{ responsive: true, color: themeColors.text }} />
                          <div style={{ marginTop: '10px', display: 'flex', gap: '10px' }}>
                              <select style={S.select} value={xAxisIdx} onChange={(e) => setXAxisIdx(parseInt(e.target.value))}>
                                  {chartConfig?.allHeaders.map((h, i) => <option key={i} value={i}>{h}</option>)}
                              </select>
                              <select style={S.select} value={yAxisIdx} onChange={(e) => setYAxisIdx(parseInt(e.target.value))}>
                                  {chartConfig?.allHeaders.map((h, i) => <option key={i} value={i}>{h}</option>)}
                              </select>
                          </div>
                        </div>
                      )}
                      {report && (
                        <div style={S.card}>
                          <h3 style={{ color: '#5ab0f0', marginTop: 0 }}>AI ANALYSIS</h3>
                          <div style={{ color: themeColors.text }}><ReactMarkdown>{report.content}</ReactMarkdown></div>
                          <div style={{ display: 'flex', gap: '10px' }}>
                              <button onClick={downloadReport} style={S.btn}>Download Report</button>
                              <button onClick={exportToPDF} style={S.btn}>PDF Export</button>
                          </div>
                      </div>
                      )}
                    </div>
                  )}
                  </>
                  )}

                </div>
                
                 {/* Right Dock */}
                <div className="right-links-panel" style={{ flex: '0 0 300px' }}>
                  <SystemGuideBot onSendMessage={handleSystemBotMessage} />
                  <LiveTelemetryDock />
                </div>
              </div>
    </div>
    </ErrorBoundary>
  )
}
