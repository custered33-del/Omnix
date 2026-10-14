import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useAuth, type User } from '../src/state/auth.js';
import { SetupGuide } from '../src/pages/SetupGuide.js';
import { Troubleshooting } from '../src/pages/Troubleshooting.js';

type Setup = User['setup'];

let server: { setup: Setup; patches: Partial<Setup>[]; selfTests: unknown[]; info: Record<string, unknown> };

function user(setup: Setup): User {
  return { id: 'u1', email: 'seb@example.com', name: 'Seb', role: 'owner', createdAt: '', preferences: { theme: 'system', reducedMotion: 'system', locale: 'en', pressureGamma: 1 }, setup };
}

function mockServer(setup: Partial<Setup> = {}, info: Record<string, unknown> = {}) {
  server = {
    setup: { completed: ['account'], current: 'open-connectors', dismissed: false, updatedAt: '', ...setup },
    patches: [],
    selfTests: [],
    info: { publicUrl: 'http://localhost:4317', mcpUrl: 'http://localhost:4317/mcp', local: true, https: false, storage: 'file', blobs: 'local', dataDir: '/home/seb/.omnix-data', ...info },
  };
  useAuth.setState({ status: 'signedIn', user: user(server.setup) });
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u === '/api/auth/me' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { setup: Partial<Setup> };
      server.patches.push(body.setup);
      server.setup = { ...server.setup, ...body.setup };
      return json({ user: user(server.setup) });
    }
    if (u === '/api/claude/setup-info') return json(server.info);
    if (u === '/api/claude/self-test') {
      server.selfTests.push(JSON.parse(String(init?.body ?? '{}')));
      return json({
        ok: false,
        testProjectId: null,
        checks: [
          { id: 'address', label: 'Address for Claude', status: 'warn', detail: 'Only this computer can reach it.', fix: 'Use a tunnel.', help: 'local-address' },
          { id: 'mcp', label: 'Omnix answers like a connector', status: 'pass', detail: '10 tools.' },
          { id: 'read', label: 'Read your project list', status: 'fail', detail: 'Boom', fix: 'Run it again.', help: 'permissions' },
        ],
      });
    }
    if (u.startsWith('/api/claude/status')) return json({ connected: false, connections: [], jobs: { running: 0, awaitingApproval: 0, list: [] }, openProposals: 0, proposalsByProject: [], lastActivity: null, mcpUrl: '' });
    return json({});
  }) as typeof fetch;
}

const renderGuide = (path = '/setup') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SetupGuide />
    </MemoryRouter>,
  );

describe('Claude setup guide', () => {
  beforeEach(() => mockServer());

  it('resumes where you left off and shows progress', async () => {
    mockServer({ completed: ['account', 'open-connectors', 'add-connector', 'oauth'], current: 'scope' });
    renderGuide();
    expect(screen.getByRole('heading', { level: 2, name: 'Choose what Claude may do' })).toBeInTheDocument();
    expect(screen.getByText('Step 5 of 7')).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')[0]).toHaveAttribute('aria-valuenow', '4');
    const nav = screen.getByRole('navigation', { name: 'Setup progress' });
    expect(within(nav).getByRole('button', { name: /Choose what Claude may do/ })).toHaveAttribute('aria-current', 'step');
    expect(within(nav).getByRole('button', { name: 'Sign in and approve (Completed)' })).toBeInTheDocument();
  });

  it('saves each completed step, moves on, and can go back', async () => {
    renderGuide();
    expect(screen.getByRole('heading', { level: 2, name: "Open Claude's connector settings" })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Claude connector settings/ })).toHaveAttribute('href', 'https://claude.ai/settings/connectors');
    await userEvent.click(screen.getByRole('button', { name: /Continue/ }));
    const heading = screen.getByRole('heading', { level: 2, name: 'Add Omnix as a connector' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(server.patches.at(-1)).toEqual({ completed: ['account', 'open-connectors'], current: 'add-connector' });
    await userEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(screen.getByRole('heading', { level: 2, name: "Open Claude's connector settings" })).toBeInTheDocument();
    expect(server.patches.at(-1)).toEqual({ current: 'open-connectors' });
  });

  it('explains what is stored and where', async () => {
    renderGuide('/setup?step=account');
    expect(screen.getByText(/You are signed in as Seb/)).toBeInTheDocument();
    expect(await screen.findByText('/home/seb/.omnix-data')).toBeInTheDocument();
    expect(screen.getByText(/salted hash of your password/)).toBeInTheDocument();
    expect(screen.getByText(/sends nothing to Anthropic by itself/)).toBeInTheDocument();
  });

  it('gives the connector URL with a copy button, and warns about local addresses', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderGuide('/setup?step=add-connector');
    const url = await screen.findByRole('textbox', { name: 'Remote MCP server URL' });
    expect(url).toHaveValue('http://localhost:4317/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Copy: Remote MCP server URL' }));
    expect(writeText).toHaveBeenCalledWith('http://localhost:4317/mcp');
    expect(await screen.findByRole('button', { name: 'Copy: Remote MCP server URL' })).toHaveTextContent('Copied');
    expect(screen.getByText('Claude.ai cannot reach this address')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How to fix this' })).toHaveAttribute('href', '/help/troubleshooting#local-address');
  });

  it('explains each permission before you approve', () => {
    renderGuide('/setup?step=oauth');
    for (const name of ['See your projects', 'Propose changes', 'Work on its own', 'Which projects']) expect(screen.getByText(name)).toBeInTheDocument();
    expect(screen.getByText(/Untick anything you do not want to allow/)).toBeInTheDocument();
  });

  it('chooses a scope preset with the mouse or arrow keys and saves it', async () => {
    renderGuide('/setup?step=scope');
    const group = screen.getByRole('radiogroup', { name: 'Choose what Claude may do' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    radios[1]!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: /Autonomous/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: /Autonomous/ })).toHaveFocus();
    expect(server.patches.at(-1)).toEqual({ preset: 'autonomous' });
    await userEvent.click(within(group).getByRole('radio', { name: /View only/ }));
    expect(server.patches.at(-1)).toEqual({ preset: 'view' });
  });

  it('runs the connection test and shows a fix for each problem', async () => {
    mockServer({ preset: 'view' });
    renderGuide('/setup?step=test');
    expect(screen.getByText('Testing as: View only')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Run the test/ }));
    expect(await screen.findByText('Something needs fixing before Claude can use Omnix.')).toBeInTheDocument();
    expect(server.selfTests).toEqual([{ mode: 'view' }]);
    const checks = screen.getAllByRole('listitem').filter((li) => li.classList.contains('check'));
    expect(checks.map((c) => c.className)).toEqual(['check warn', 'check pass', 'check fail']);
    expect(within(checks[2]!).getByText('Run it again.')).toBeInTheDocument();
    expect(within(checks[2]!).getByRole('link', { name: 'More help' })).toHaveAttribute('href', '/help/troubleshooting#permissions');
    // A failed test does not mark the step done.
    expect(server.patches.some((p) => p.completed?.includes('test'))).toBe(false);
    expect(screen.getByText('Waiting for Claude to reach Omnix…')).toBeInTheDocument();
  });

  it('offers the sample project with AI consent you can untick', async () => {
    renderGuide('/setup?step=first-project');
    const allow = screen.getByRole('checkbox', { name: 'Allow AI in the sample project' });
    expect(allow).toBeChecked();
    await userEvent.click(allow);
    expect(allow).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Open the sample/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Take a one-minute tour/ })).toBeInTheDocument();
  });
});

describe('Troubleshooting', () => {
  const renderPage = (path = '/help/troubleshooting') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Troubleshooting />
      </MemoryRouter>,
    );

  it('covers connection errors, expired sign-in, permissions and disconnecting', () => {
    renderPage();
    for (const name of ['Connection errors', 'Expired sign-in', 'Permission problems', 'Disconnecting']) expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Run the connection test/ })[0]).toHaveAttribute('href', '/setup?step=test');
  });

  it('opens the entry a link points at', () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { container } = renderPage('/help/troubleshooting#local-address');
    const item = container.querySelector('#local-address') as HTMLDetailsElement;
    expect(item.open).toBe(true);
    expect(within(item).getByText(/cloudflared tunnel/)).toBeInTheDocument();
  });

  it('filters entries by what you type', async () => {
    const { container } = renderPage();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter problems' }), 'revoke');
    const titles = Array.from(container.querySelectorAll('summary')).map((s) => s.textContent);
    expect(titles).toEqual(['Claude says it needs to sign in to Omnix again', 'Stop Claude from using Omnix']);
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Filter problems' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter problems' }), 'zzzz');
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });
});
