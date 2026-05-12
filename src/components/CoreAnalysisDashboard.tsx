import React, { useState, useMemo } from 'react';
import { 
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, 
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer 
} from 'recharts';

interface CoreAnalysisDashboardProps {
  rawData: any[];
  targetMetric: string;
  filename: string;
}

const CoreAnalysisDashboard: React.FC<CoreAnalysisDashboardProps> = ({ rawData, targetMetric, filename }) => {
  const [activeTab, setActiveTab] = useState('XY'); // Default view

  // COLORS FOR AEROSPACE THEME
  const COLORS = ['#10b981', '#0ea5e9', '#f59e0b', '#ef4444'];

  // 1. DATA PROCESSING ENGINE
  const processedData = useMemo(() => {
    if (!rawData || rawData.length === 0) return null;

    let low = 0, moderate = 0, high = 0, critical = 0;
    const isNdvi = targetMetric.toLowerCase().includes('ndvi') || targetMetric.toLowerCase().includes('evi');
    const isTemp = targetMetric.toLowerCase().includes('temp') || targetMetric.toLowerCase().includes('lst');
    const isPrecip = targetMetric.toLowerCase().includes('precip') || targetMetric.toLowerCase().includes('rain');
    const isEvap = targetMetric.toLowerCase().includes('evapo');
    const isSolar = targetMetric.toLowerCase().includes('solar') || targetMetric.toLowerCase().includes('rad');
    
    const chartData = rawData.map((row, index) => {
      const val = row[targetMetric];
      
      const labelValue = row.Date || row.Time || row.Year || row.Timestamp || row.date || row.time || row.timestamp || `Pt ${index}`;

      if (isNdvi) {
        if (val < 0.2) critical++;
        else if (val < 0.4) low++;
        else if (val < 0.7) moderate++;
        else high++;
      } else if (isTemp) {
        if (val < 10) critical++; // Frozen/Cold
        else if (val < 20) low++; // Cool
        else if (val < 30) moderate++; // Warm
        else high++; // Hot
      } else if (isPrecip) {
        if (val < 0.1) critical++; // Drought/Zero
        else if (val < 2) low++; // Light
        else if (val < 10) moderate++; // Heavy
        else high++; // Extreme
      } else if (isEvap) {
        if (val < 2) critical++; 
        else if (val < 5) low++; 
        else if (val < 10) moderate++; 
        else high++; 
      } else if (isSolar) {
        if (val < 5) critical++; 
        else if (val < 15) low++; 
        else if (val < 25) moderate++; 
        else high++; 
      } else {
        // Generic distribution for other data
        if (val === 0 || !val) critical++;
        else if (val < 5) low++;
        else if (val < 20) moderate++;
        else high++;
      }

      return {
        name: labelValue,
        value: val
      };
    }).slice(0, 100);

    const distributionData = isNdvi ? [
      { name: 'Critical/Barren', value: critical },
      { name: 'Low Density', value: low },
      { name: 'Moderate/Healthy', value: moderate },
      { name: 'High Density', value: high }
    ].filter(d => d.value > 0) : isTemp ? [
      { name: 'Frozen/Cold', value: critical },
      { name: 'Cool/Nominal', value: low },
      { name: 'Moderate/Warm', value: moderate },
      { name: 'Hot/Extreme', value: high }
    ].filter(d => d.value > 0) : isPrecip ? [
      { name: 'Zero/Arid', value: critical },
      { name: 'Light Rainfall', value: low },
      { name: 'Standard Rainfall', value: moderate },
      { name: 'Extreme Rainfall', value: high }
    ].filter(d => d.value > 0) : isEvap ? [
      { name: 'Low/Arid', value: critical },
      { name: 'Standard Evap', value: low },
      { name: 'Humid/High', value: moderate },
      { name: 'Saturation', value: high }
    ].filter(d => d.value > 0) : isSolar ? [
      { name: 'Overcast/Low', value: critical },
      { name: 'Moderate Sun', value: low },
      { name: 'Clear/Bright', value: moderate },
      { name: 'Peak Radiation', value: high }
    ].filter(d => d.value > 0) : [
      { name: 'Trace/Zero', value: critical },
      { name: 'Low Intensity', value: low },
      { name: 'Moderate Intensity', value: moderate },
      { name: 'High Intensity', value: high }
    ].filter(d => d.value > 0);

    return { chartData, distributionData };
  }, [rawData, targetMetric]);

  if (!processedData) return null;

  // 2. CUSTOM TOOLTIP (Dark Mode)
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div style={{ background: '#020617', border: '1px solid #0ea5e9', padding: '10px', fontFamily: 'Space Mono' }}>
          <p style={{ color: '#94a3b8', fontSize: '10px', margin: 0 }}>{label}</p>
          <p style={{ color: payload[0].color || '#10b981', fontSize: '12px', fontWeight: 'bold', margin: 0 }}>
            {payload[0].name}: {payload[0].value.toFixed(3)}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="core-analysis-module">
      <div className="analysis-header">
        <span className="pulse-dot"></span> CORE ANALYSIS // {filename}
      </div>

      {/* INTERACTIVE VIEW TOGGLES */}
      <div className="view-toggles">
        <button className={activeTab === 'XY' ? 'active' : ''} onClick={() => setActiveTab('XY')}>[ XY SERIES ]</button>
        <button className={activeTab === 'BAR' ? 'active' : ''} onClick={() => setActiveTab('BAR')}>[ BAR GRAPH ]</button>
        <button className={activeTab === 'PIE' ? 'active' : ''} onClick={() => setActiveTab('PIE')}>[ DISTRIBUTION ]</button>
        <button className={activeTab === 'TABLE' ? 'active' : ''} onClick={() => setActiveTab('TABLE')}>[ RAW DATA ]</button>
      </div>

      {/* DYNAMIC RENDER WINDOW */}
      <div className="render-window">
        
        {/* VIEW 1: XY GRAPH (LINE) */}
        {activeTab === 'XY' && (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={processedData.chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="name" stroke="#475569" fontSize={10} tick={{fontFamily: 'Space Mono'}} hide />
              <YAxis stroke="#475569" fontSize={10} tick={{fontFamily: 'Space Mono'}} />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: '11px', fontFamily: 'Space Mono', color: '#94a3b8' }} />
              <Line type="monotone" dataKey="value" name={targetMetric} stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 6 }} />
            </LineChart>
          </ResponsiveContainer>
        )}

        {/* VIEW 2: BAR GRAPH */}
        {activeTab === 'BAR' && (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={processedData.chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="name" hide />
              <YAxis stroke="#475569" fontSize={10} tick={{fontFamily: 'Space Mono'}} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="value" name={targetMetric} fill="#0ea5e9" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}

        {/* VIEW 3: PIE CHART */}
        {activeTab === 'PIE' && (
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: '11px', fontFamily: 'Space Mono' }} />
              <Pie
                data={processedData.distributionData}
                cx="50%" cy="45%"
                innerRadius={60} outerRadius={90}
                paddingAngle={5} dataKey="value"
              >
                {processedData.distributionData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        )}

        {/* VIEW 4: TABULAR RAW DATA */}
        {activeTab === 'TABLE' && (
          <div className="tabular-view">
            <table>
              <thead>
                <tr>
                  <th>RECORD ID</th>
                  <th>{targetMetric} VALUE</th>
                  <th>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {processedData.chartData.map((row, i) => (
                  <tr key={i}>
                    <td>{row.name}</td>
                    <td style={{ color: '#0ea5e9', fontWeight: 'bold' }}>{row.value?.toFixed(4)}</td>
                    <td style={{ color: row.value > 0.4 ? '#10b981' : '#ef4444' }}>
                      {row.value > 0.4 ? 'NOMINAL' : 'ALERT'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      </div>
    </div>
  );
};

export default CoreAnalysisDashboard;
