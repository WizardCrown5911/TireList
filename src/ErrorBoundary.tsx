import { Component, type ReactNode } from 'react'

type ErrorBoundaryProps = {
  children: ReactNode
}

type ErrorBoundaryState = {
  errorMessage: string
  hasError: boolean
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    errorMessage: '',
    hasError: false,
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      errorMessage:
        error instanceof Error
          ? error.message
          : 'The tier list UI hit an unexpected error.',
      hasError: true,
    }
  }

  componentDidCatch(error: unknown) {
    console.error('Tier list UI crashed.', error)
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    return (
      <div className="app-shell error-shell">
        <section className="panel error-panel">
          <div className="panel-header">
            <h2>UI Error</h2>
          </div>
          <div className="panel-body error-body">
            <p>
              The drag-and-drop UI hit an unexpected state and stopped rendering.
            </p>
            <p>{this.state.errorMessage}</p>
            <button className="accent-button" onClick={this.handleReload} type="button">
              Reload app
            </button>
          </div>
        </section>
      </div>
    )
  }
}

export default ErrorBoundary
