import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { PrefsProvider } from './lib/prefs';
import { ToastProvider } from './lib/toast';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrefsProvider>
      <ToastProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </ToastProvider>
    </PrefsProvider>
  </StrictMode>,
);

// Offline support for the installed app; not in development or the sandboxed preview.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('TerraX: offline support unavailable', err));
  });
}
