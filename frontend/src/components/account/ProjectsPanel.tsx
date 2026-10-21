import { useCallback, useEffect, useState } from 'react';
import { request } from '../../lib/api';
import { parseProject, type Project } from '../../lib/project';
import { useToast } from '../../lib/toast';

interface ProjectSummary {
  id: string;
  name: string;
  created: number;
  updated: number;
  access: 'owner' | 'edit' | 'read';
  ownerEmail: string | null;
}

interface Share {
  userId: string;
  email: string;
  canEdit: boolean;
}

/** Projects kept on the server: the same document as a .terrax.json export, shared with other accounts if wanted. */
export default function ProjectsPanel({ currentProject, applyProject }: { currentProject: () => Project; applyProject: (p: Project, done: string) => void }) {
  const notify = useToast();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState(`Project ${new Date().toISOString().slice(0, 10)}`);
  const [sharing, setSharing] = useState<{ id: string; shares: Share[] } | null>(null);
  const [shareEmail, setShareEmail] = useState('');
  const [shareEdit, setShareEdit] = useState(false);
  const fail = useCallback((err: unknown) => notify(err instanceof Error ? err.message : 'That did not work.', 'error'), [notify]);
  const load = useCallback(() => {
    request<{ projects: ProjectSummary[] }>('/api/projects').then(r => setList(r.projects), fail);
  }, [fail]);
  useEffect(load, [load]);

  const save = async () => {
    try {
      await request('/api/projects', { method: 'POST', json: { name: name.trim() || 'Project', data: currentProject() } });
      notify('Project saved on the server.', 'success');
      load();
    } catch (err) {
      fail(err);
    }
  };
  const overwrite = async (p: ProjectSummary) => {
    if (!window.confirm(`Replace “${p.name}” with the current boundary, target, reports and settings?`)) return;
    try {
      await request(`/api/projects/${p.id}`, { method: 'PUT', json: { data: currentProject() } });
      notify(`“${p.name}” updated.`, 'success');
      load();
    } catch (err) {
      fail(err);
    }
  };
  const open = async (p: ProjectSummary) => {
    try {
      const r = await request<{ data: unknown }>(`/api/projects/${p.id}`);
      applyProject(parseProject(r.data), `“${p.name}” opened`);
    } catch (err) {
      fail(err);
    }
  };
  const remove = async (p: ProjectSummary) => {
    if (!window.confirm(`Delete “${p.name}” from the server?`)) return;
    try {
      await request(`/api/projects/${p.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      fail(err);
    }
  };
  const showShares = async (p: ProjectSummary) => {
    if (sharing?.id === p.id) return setSharing(null);
    try {
      const r = await request<{ shares: Share[] }>(`/api/projects/${p.id}`);
      setSharing({ id: p.id, shares: r.shares ?? [] });
    } catch (err) {
      fail(err);
    }
  };
  const share = async (id: string) => {
    try {
      const s = await request<Share>(`/api/projects/${id}/shares`, { method: 'POST', json: { email: shareEmail, canEdit: shareEdit } });
      setSharing(x => (x ? { ...x, shares: [...x.shares.filter(y => y.userId !== s.userId), s] } : x));
      setShareEmail('');
    } catch (err) {
      fail(err);
    }
  };
  const unshare = async (id: string, userId: string) => {
    try {
      await request(`/api/projects/${id}/shares/${userId}`, { method: 'DELETE' });
      setSharing(x => (x ? { ...x, shares: x.shares.filter(y => y.userId !== userId) } : x));
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div className="projects-panel">
      <div className="param-row">
        <label className="param grow">
          <span>Save the current boundary, target, reports and settings as</span>
          <input id="project-name" type="text" maxLength={200} value={name} onChange={e => setName(e.target.value)} />
        </label>
        <button type="button" id="project-save" className="btn btn-primary" onClick={save}>
          Save on the server
        </button>
      </div>
      {!list ? (
        <div className="loading-block">Loading…</div>
      ) : !list.length ? (
        <p className="empty-note">No projects on the server yet.</p>
      ) : (
        <ul className="history-list">
          {list.map(p => (
            <li key={p.id} className="history-item">
              <div className="history-row static">
                <span className="history-tool">{p.name}</span>
                <span className="history-name">{p.access === 'owner' ? 'yours' : `${p.access === 'edit' ? 'can edit' : 'read only'}, from ${p.ownerEmail}`}</span>
                <span className="history-when">updated {new Date(p.updated * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </div>
              <div className="button-row">
                <button type="button" className="btn btn-small" onClick={() => open(p)}>
                  Open
                </button>
                {p.access !== 'read' && (
                  <button type="button" className="btn btn-small" onClick={() => overwrite(p)}>
                    Update with current
                  </button>
                )}
                {p.access === 'owner' && (
                  <button type="button" className="btn btn-small" onClick={() => showShares(p)}>
                    Share…
                  </button>
                )}
                {p.access === 'owner' && (
                  <button type="button" className="btn btn-small btn-danger" onClick={() => remove(p)}>
                    Delete
                  </button>
                )}
              </div>
              {sharing?.id === p.id && (
                <div className="history-detail">
                  {sharing.shares.length ? (
                    <ul className="share-list">
                      {sharing.shares.map(s => (
                        <li key={s.userId}>
                          {s.email} ({s.canEdit ? 'can edit' : 'read only'}){' '}
                          <button type="button" className="link-btn" onClick={() => unshare(p.id, s.userId)}>
                            remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="field-hint">Not shared with anyone.</p>
                  )}
                  <div className="param-row">
                    <label className="param grow">
                      <span>Share with (an account on this server)</span>
                      <input type="email" value={shareEmail} placeholder="colleague@example.org" onChange={e => setShareEmail(e.target.value)} />
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={shareEdit} onChange={e => setShareEdit(e.target.checked)} /> can edit
                    </label>
                    <button type="button" className="btn btn-small" disabled={!shareEmail.includes('@')} onClick={() => share(p.id)}>
                      Share
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
