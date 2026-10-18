import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Home, FolderOpen, Bookmark, Activity, Search, Smartphone, HelpCircle, Settings, LogOut, Keyboard, Sparkles, LifeBuoy, Sun, Moon, Contrast, Monitor } from 'lucide-react';
import { useAuth } from '../state/auth.js';
import { realtime } from '../state/realtime.js';
import { useCommandStore, useCommands } from '../state/commands.js';
import { MenuButton, Avatar } from '../ui/primitives.js';
import { useShortcuts, formatShortcut } from '../ui/shortcuts.js';
import { t } from '../i18n/index.js';
import { TOOL_KINDS, type ToolKind } from '@omnix/core';
import { createProject } from '../lib/projects.js';
import { PhoneDialog } from '../components/PhoneDialog.js';

export function useConnectionStatus(): 'connecting' | 'open' | 'closed' {
  const [s, setS] = useState(realtime.status);
  useEffect(() => realtime.onStatus(setS), []);
  return s;
}

/** Global commands and shortcuts available everywhere. */
export function useGlobalCommands(): void {
  const navigate = useNavigate();
  const updatePreferences = useAuth((s) => s.updatePreferences);
  const openPalette = useCommandStore((s) => s.openPalette);
  const openShortcuts = useCommandStore((s) => s.openShortcuts);
  useCommands(
    'global',
    [
      { id: 'go-home', label: t('nav.home'), section: t('palette.goTo'), run: () => navigate('/') },
      { id: 'go-assets', label: t('nav.assets'), section: t('palette.goTo'), run: () => navigate('/assets') },
      { id: 'go-presets', label: t('nav.presets'), section: t('palette.goTo'), keywords: 'look effects theme styles rig template', run: () => navigate('/presets') },
      { id: 'go-activity', label: t('nav.activity'), section: t('palette.goTo'), run: () => navigate('/activity') },
      { id: 'go-settings', label: t('nav.settings'), section: t('palette.goTo'), run: () => navigate('/settings') },
      { id: 'go-setup', label: t('nav.setupGuide'), section: t('palette.goTo'), run: () => navigate('/setup') },
      ...TOOL_KINDS.map((tool: ToolKind) => ({
        id: `new-${tool}`,
        label: `${t('dashboard.create')}: ${t(`tools.${tool}Long`)}`,
        section: t('palette.create'),
        run: () => void createProject(tool).then((p) => navigate(`/projects/${p.id}`)),
      })),
      { id: 'theme-light', label: `${t('settings.theme')}: ${t('settings.themeLight')}`, section: t('palette.actions'), run: () => void updatePreferences({ theme: 'light' }) },
      { id: 'theme-dark', label: `${t('settings.theme')}: ${t('settings.themeDark')}`, section: t('palette.actions'), run: () => void updatePreferences({ theme: 'dark' }) },
      { id: 'theme-hc', label: `${t('settings.theme')}: ${t('settings.themeContrast')}`, section: t('palette.actions'), run: () => void updatePreferences({ theme: 'high-contrast' }) },
      { id: 'theme-system', label: `${t('settings.theme')}: ${t('settings.themeSystem')}`, section: t('palette.actions'), run: () => void updatePreferences({ theme: 'system' }) },
      { id: 'shortcuts', label: t('nav.shortcuts'), section: t('palette.actions'), shortcut: 'shift+?', run: () => openShortcuts(true) },
    ],
    [navigate],
  );
  useShortcuts(
    {
      'mod+k': () => openPalette(true),
      'shift+?': () => openShortcuts(true),
    },
    [],
    { allowInInputs: ['mod+k'] },
  );
}

export function UserMenu() {
  const user = useAuth((s) => s.user)!;
  const logout = useAuth((s) => s.logout);
  const updatePreferences = useAuth((s) => s.updatePreferences);
  const navigate = useNavigate();
  const openShortcuts = useCommandStore((s) => s.openShortcuts);
  return (
    <MenuButton
      label={t('nav.account')}
      className="icon-btn"
      items={[
        { label: user.name, heading: true },
        { label: t('nav.settings'), icon: <Settings />, onSelect: () => navigate('/settings') },
        { label: t('nav.shortcuts'), icon: <Keyboard />, shortcut: formatShortcut('shift+?'), onSelect: () => openShortcuts(true) },
        { separator: true, label: '' },
        { label: t('nav.appearance'), heading: true },
        { label: t('settings.themeSystem'), icon: <Monitor />, onSelect: () => void updatePreferences({ theme: 'system' }) },
        { label: t('settings.themeLight'), icon: <Sun />, onSelect: () => void updatePreferences({ theme: 'light' }) },
        { label: t('settings.themeDark'), icon: <Moon />, onSelect: () => void updatePreferences({ theme: 'dark' }) },
        { label: t('settings.themeContrast'), icon: <Contrast />, onSelect: () => void updatePreferences({ theme: 'high-contrast' }) },
        { separator: true, label: '' },
        { label: t('nav.signOut'), icon: <LogOut />, onSelect: () => void logout() },
      ]}
    >
      <Avatar name={user.name} color="#3b5bdb" />
    </MenuButton>
  );
}

export function HelpMenu() {
  const navigate = useNavigate();
  const openShortcuts = useCommandStore((s) => s.openShortcuts);
  return (
    <MenuButton
      label={t('nav.help')}
      items={[
        { label: t('nav.setupGuide'), icon: <Sparkles />, onSelect: () => navigate('/setup') },
        { label: 'Troubleshooting', icon: <LifeBuoy />, onSelect: () => navigate('/help/troubleshooting') },
        { label: t('nav.shortcuts'), icon: <Keyboard />, onSelect: () => openShortcuts(true) },
      ]}
    >
      <HelpCircle />
    </MenuButton>
  );
}

export function Shell() {
  const status = useConnectionStatus();
  const openPalette = useCommandStore((s) => s.openPalette);
  useGlobalCommands();
  const [phone, setPhone] = useState(false);
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label={`${t('app.name')} ${t('nav.home')}`}>
          <span className="brand-mark" aria-hidden="true" />
          {t('app.name')}
        </NavLink>
        <nav className="topnav" aria-label="Main">
          <NavLink to="/" end>
            {t('nav.home')}
          </NavLink>
          <NavLink to="/assets">{t('nav.assets')}</NavLink>
          <NavLink to="/presets">{t('nav.presets')}</NavLink>
          <NavLink to="/activity">{t('nav.activity')}</NavLink>
        </nav>
        <div className="spacer" />
        {status !== 'open' && (
          <span className="conn-dot" role="status">
            {t('app.offline')}
          </span>
        )}
        <button className="btn btn-ghost btn-sm palette-btn" onClick={() => openPalette(true)} aria-label={t('nav.commandPalette')}>
          <Search />
          <span className="muted">{formatShortcut('mod+k')}</span>
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setPhone(true)} aria-label="Open on your phone" title="Open on your phone">
          <Smartphone />
          <span className="phone-btn-label">Phone</span>
        </button>
        <HelpMenu />
        <UserMenu />
      </header>
      {phone && <PhoneDialog onClose={() => setPhone(false)} />}
      <main id="main" className="grow" tabIndex={-1}>
        <Outlet />
      </main>
      {/* Phones: the main places as a tab bar at the bottom, in thumb reach. */}
      <nav className="phone-tabs" aria-label="Main (phone)">
        <NavLink to="/" end>
          <Home aria-hidden="true" />
          {t('nav.home')}
        </NavLink>
        <NavLink to="/assets">
          <FolderOpen aria-hidden="true" />
          {t('nav.assets')}
        </NavLink>
        <NavLink to="/presets">
          <Bookmark aria-hidden="true" />
          {t('nav.presets')}
        </NavLink>
        <NavLink to="/activity">
          <Activity aria-hidden="true" />
          {t('nav.activity')}
        </NavLink>
      </nav>
    </div>
  );
}
