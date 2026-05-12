import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  // Update state so the next render shows the fallback UI.
  static getDerivedStateFromError(error: Error) {
    return { hasError: true };
  }

  // Log the error to an error reporting service (or console for hackathon)
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("TERRASENSE SYSTEM ANOMALY CAUGHT:", error);
    this.setState({ errorMessage: error.toString() });
  }

  render() {
    if (this.state.hasError) {
      // You can render any custom fallback UI
      return (
        <div style={{
          backgroundColor: '#020617',
          color: '#f8fafc',
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "'Space Mono', monospace",
          textAlign: 'center',
          padding: '20px'
        }}>
          <div style={{ border: '1px dashed #ef4444', padding: '40px', background: 'rgba(239, 68, 68, 0.05)' }}>
            <h1 style={{ color: '#ef4444', fontSize: '24px', marginBottom: '10px' }}>
              [!] CRITICAL MODULE ANOMALY
            </h1>
            <p style={{ color: '#94a3b8', marginBottom: '30px' }}>
              A subsystem encountered an unexpected data fault. The core operating system has safely contained the error.
            </p>
            <button 
              onClick={() => window.location.reload()} 
              style={{
                background: 'transparent',
                border: '1px solid #0ea5e9',
                color: '#0ea5e9',
                padding: '12px 24px',
                fontFamily: "'Space Mono', monospace",
                cursor: 'pointer',
                letterSpacing: '1px'
              }}
            >
              [ INITIATE SYSTEM REBOOT ]
            </button>
          </div>
        </div>
      );
    }

    // If no error, render the app normally
    return this.props.children; 
  }
}

export default ErrorBoundary;
