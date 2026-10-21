import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { AccountProvider } from './lib/account';
import { installErrorReporting } from './lib/errorReport';
import { PrefsProvider } from './lib/prefs';
import { ToastProvider } from './lib/toast';
import './index.css';

installErrorReporting();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrefsProvider>
      <ToastProvider>
        <AccountProvider>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </AccountProvider>
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
