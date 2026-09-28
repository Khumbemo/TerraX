import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Short name of the area this boundary protects, shown in the fallback. */
  area?: string;
  /** Render a compact inline fallback instead of a full-screen one. */
  inline?: boolean;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`TerraX: ${this.props.area ?? 'app'} crashed`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={this.props.inline ? 'error-panel' : 'error-screen'} role="alert">
        <div className="error-card">
          <h2>{this.props.area ? `${this.props.area} stopped working` : 'TerraX stopped working'}</h2>
          <p>Something went wrong while showing this part of the app. Your saved reports are not affected.</p>
          <pre className="error-detail">{error.message}</pre>
          <div className="button-row">
            <button type="button" className="btn btn-primary" onClick={this.reset}>
              Try again
            </button>
            {!this.props.inline && (
              <button type="button" className="btn" onClick={() => window.location.reload()}>
                Reload TerraX
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
