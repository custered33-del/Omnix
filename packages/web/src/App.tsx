import { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './state/auth.js';
import { realtime } from './state/realtime.js';
import { Toasts, Spinner } from './ui/primitives.js';
import { AuthPage } from './pages/AuthPage.js';
import { Shell } from './shell/Shell.js';
import { Dashboard } from './pages/Dashboard.js';
import { CommandPalette } from './shell/CommandPalette.js';
import { ShortcutsDialog } from './shell/ShortcutsDialog.js';
import { t } from './i18n/index.js';

const ProjectPage = lazy(() => import('./pages/ProjectPage.js').then((m) => ({ default: m.ProjectPage })));
const AssetsPage = lazy(() => import('./pages/AssetsPage.js').then((m) => ({ default: m.AssetsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage.js').then((m) => ({ default: m.SettingsPage })));
const ActivityPage = lazy(() => import('./pages/ActivityPage.js').then((m) => ({ default: m.ActivityPage })));
const SetupGuide = lazy(() => import('./pages/SetupGuide.js').then((m) => ({ default: m.SetupGuide })));
const ConnectPage = lazy(() => import('./pages/ConnectPage.js').then((m) => ({ default: m.ConnectPage })));
const Troubleshooting = lazy(() => import('./pages/Troubleshooting.js').then((m) => ({ default: m.Troubleshooting })));
const PresentPage = lazy(() => import('./pages/PresentPage.js').then((m) => ({ default: m.PresentPage })));

export function Loading() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', minHeight: 200 }}>
      <Spinner label={t('app.loading')} />
    </div>
  );
}

function Authed() {
  const status = useAuth((s) => s.status);
  useEffect(() => {
    if (status === 'signedIn') realtime.start();
    else realtime.stop();
  }, [status]);
  if (status === 'loading') return <Loading />;
  if (status === 'signedOut') return <AuthPage />;
  return (
    <>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Dashboard />} />
            <Route path="assets" element={<AssetsPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="settings/*" element={<SettingsPage />} />
            <Route path="setup" element={<SetupGuide />} />
            <Route path="help/troubleshooting" element={<Troubleshooting />} />
          </Route>
          <Route path="projects/:projectId" element={<ProjectPage />} />
          {/* Claude's connector sign-in lands here (after /oauth/authorize). */}
          <Route path="connect/:requestId" element={<ConnectPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <CommandPalette />
      <ShortcutsDialog />
    </>
  );
}

export function App() {
  const load = useAuth((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <BrowserRouter>
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <Routes>
        {/* Public, read-only presentation links work without signing in. */}
        <Route
          path="present/:shareId"
          element={
            <Suspense fallback={<Loading />}>
              <PresentPage />
            </Suspense>
          }
        />
        <Route path="*" element={<Authed />} />
      </Routes>
      <Toasts />
    </BrowserRouter>
  );
}
