import React from 'react';
import ReactDOM from 'react-dom/client';
import './i18n/config';
import './index.css';
import App from './App';
import RemoteControlApp from './components/remote/RemoteControlApp';
import ObsBrowserSourceApp from './components/obs/ObsBrowserSourceApp';
import ObsNowPlayingSourceApp from './components/obs/ObsNowPlayingSourceApp';
import ObsPlayerCapSourceApp from './components/obs/ObsPlayerCapSourceApp';

// src/bootstrap.tsx
// Mounts the React app after index.tsx installs runtime-level browser shims.

// ---------------------------------------------------------------------------
// ErrorBoundary
//
// 为什么需要：之前整个应用没有错误边界，任何一次渲染期抛错都会让 React 把
// 整棵树卸载掉，用户看到的就是【纯黑屏 + 毫无提示】，在 iOS 上又没有 Web
// Inspector 可用，等于完全无法定位。
//
// 有了它，渲染错误会变成屏幕上的一段可读文本（可以直接截图排查）。
// 这不只是调试手段 —— 对用户来说，"崩了但什么都没说" 也是最差的体验。
// ---------------------------------------------------------------------------
type ErrorBoundaryState = { error: Error | null; info: string | null };

class ErrorBoundary extends React.Component<React.PropsWithChildren<{}>, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 同时打到原生日志（Xcode / 设备控制台可见）
    console.error('[Folia] render error:', error, info.componentStack);
    this.setState({ info: info.componentStack || null });
  }

  render(): React.ReactNode {
    const { error, info } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 2147483647,
          background: '#1a0000',
          color: '#ffc9c9',
          font: '12px/1.6 ui-monospace, Menlo, Consolas, monospace',
          padding: 24,
          paddingTop: 64,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          WebkitUserSelect: 'text',
          userSelect: 'text',
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700, color: '#ff8a8a', marginBottom: 14 }}>
          ⚠️ Folia 界面渲染失败
        </div>
        <div style={{ fontSize: 13, color: '#ffb4b4', marginBottom: 16 }}>
          请把这一屏截图发给我
        </div>
        <div>{error.name}: {error.message}</div>
        {error.stack ? <div style={{ marginTop: 12, opacity: 0.8 }}>{error.stack}</div> : null}
        {info ? <div style={{ marginTop: 12, opacity: 0.6 }}>组件栈:{info}</div> : null}
      </div>
    );
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
const searchParams = new URLSearchParams(window.location.search);
const isObsBrowserSource = searchParams.get('obs') === '1' || window.location.pathname === '/obs';
const obsSource = searchParams.get('obsSource');
// obsSource=now-playing / playercap: static OBS overlay that connects directly to NowPlaying / PlayerCap in the browser (no Electron SSE relay).
const isNowPlayingObsSource = isObsBrowserSource && obsSource === 'now-playing';
const isPlayerCapObsSource = isObsBrowserSource && obsSource === 'playercap';
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      {isNowPlayingObsSource
        ? <ObsNowPlayingSourceApp />
        : isPlayerCapObsSource
          ? <ObsPlayerCapSourceApp />
          : isObsBrowserSource
            ? <ObsBrowserSourceApp />
            : searchParams.get('remote') === '1'
              ? <RemoteControlApp />
              : <App />}
    </ErrorBoundary>
  </React.StrictMode>
);
