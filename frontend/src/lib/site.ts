// What the server's administrators set in the Admin tab and every visitor may see (GET /api/site): an announcement,
// a maintenance notice, and who runs the server.
import { useEffect, useState } from 'react';
import { request } from './api';

export interface SiteInfo {
  announcement: string | null;
  maintenance: string | null;
  contact: { contactName: string | null; contactEmail: string | null; contactPhone: string | null; supportEmail: string | null; supportUrl: string | null };
  version: string | null;
  licence: string;
}

/** The site information, refreshed every few minutes (and when `refresh` changes); null until loaded or if unreachable. */
export function useSite(refresh = 0): SiteInfo | null {
  const [site, setSite] = useState<SiteInfo | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      request<SiteInfo>('/api/site').then(
        s => live && setSite(s),
        () => undefined,
      );
    load();
    const t = window.setInterval(load, 3 * 60_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [refresh]);
  return site;
}
