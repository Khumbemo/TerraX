import { getJSON, setJSON } from './storage';
import type { ReportRecord } from './types';

const KEY = 'reports';
const MAX_REPORTS = 25;

interface LegacyReport {
  filename?: string;
  content?: string;
  timestamp?: string;
}

/** Loads saved reports, migrating the single report kept by earlier versions. */
export function loadReports(): ReportRecord[] {
  const list = getJSON<ReportRecord[]>(KEY, []);
  if (list.length) return list.filter(r => r && typeof r.content === 'string');
  const legacy = getJSON<LegacyReport | null>('last_report', null);
  if (legacy?.content) {
    const migrated: ReportRecord = {
      id: `legacy-${Date.now().toString(36)}`,
      title: 'Earlier report',
      datasetName: (legacy.filename ?? '').replace(/^SOURCES:\s*/, '') || 'Unknown dataset',
      createdAt: new Date().toISOString(),
      source: 'ai',
      content: legacy.content,
    };
    setJSON(KEY, [migrated]);
    return [migrated];
  }
  return [];
}

/** Saves the list, newest first. Returns false if browser storage is unavailable or full. */
export function saveReports(list: ReportRecord[]): boolean {
  return setJSON(KEY, list.slice(0, MAX_REPORTS));
}

export { MAX_REPORTS };
