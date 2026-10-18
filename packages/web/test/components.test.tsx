import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Markdown } from '../src/components/Markdown.js';
import { ChartView } from '../src/components/ChartView.js';
import { Outputs } from '../src/editors/code/Outputs.js';
import { EasingEditor } from '../src/editors/shared/EasingEditor.js';
import { useAuth } from '../src/state/auth.js';
import { Dashboard } from '../src/pages/Dashboard.js';

describe('Markdown', () => {
  it('renders headings, lists and inline styles, and escapes raw HTML', () => {
    const { container } = render(<Markdown source={'# Title\n\nSome **bold** and <script>alert(1)</script>\n\n- one\n- two\n\n1. first'} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(1);
  });

  it('neutralizes javascript: links', () => {
    const { container } = render(<Markdown source={'[click](javascript:alert(1))'} />);
    const a = container.querySelector('a');
    expect(a?.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
  });
});

describe('ChartView', () => {
  const spec = { type: 'bar' as const, title: 'Visits', labels: ['Mon', 'Tue'], series: [{ name: 'Web', values: [120, 180] }, { name: 'App', values: [80, 95] }] };

  it('offers a table view with exact values', async () => {
    render(<ChartView spec={spec} />);
    expect(screen.getByRole('img', { name: /Bar chart: Visits/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show as table' }));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Web' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Tue' })).toBeInTheDocument();
    expect(within(table).getByText('180')).toBeInTheDocument();
  });
});

describe('code outputs', () => {
  it('shows text, errors and tables', () => {
    render(
      <Outputs
        outputs={[
          { kind: 'stdout', text: 'hello' },
          { kind: 'error', name: 'ValueError', message: 'bad input' },
          { kind: 'table', columns: ['a', 'b'], rows: [[1, 'x'], [2, null]] },
        ]}
      />,
    );
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('ValueError: bad input');
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });
});

describe('EasingEditor', () => {
  it('switches presets and enables the custom curve', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<EasingEditor value="ease-in" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Easing' }), 'custom');
    expect(onChange).toHaveBeenCalledWith({ bezier: [0.42, 0, 1, 1] });
    rerender(<EasingEditor value={{ bezier: [0.42, 0, 1, 1] }} onChange={onChange} />);
    const handles = screen.getAllByLabelText(/Handle/);
    expect(handles).toHaveLength(2);
    // Handles move with the keyboard too.
    handles[0]!.focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith({ bezier: [0.42, 0.02, 1, 1] });
  });
});

describe('Dashboard', () => {
  beforeEach(() => {
    sessionStorage.setItem('omnix.setupShown', '1');
    useAuth.setState({
      status: 'signedIn',
      user: { id: 'u1', email: 'seb@example.com', name: 'Seb', preferences: { theme: 'system', motion: 'system', locale: 'en', pressureGamma: 1 }, setup: { completed: ['account', 'server', 'token'], dismissed: true } } as never,
    });
    const project = { id: 'p1', name: 'Launch teaser', primaryTool: 'video', updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), thumbnailVersion: 1, role: 'owner', archived: false, aiConsent: true, members: [] };
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (u.startsWith('/api/projects')) return json({ projects: [project] });
      if (u.startsWith('/api/assets')) return json({ assets: [], tags: [], total: 0 });
      if (u.startsWith('/api/templates')) return json({ templates: [] });
      if (u.startsWith('/api/claude/status')) return json({ connected: false, connections: [], jobs: [], proposals: 0 });
      if (u.startsWith('/api/activity')) return json({ entries: [] });
      return json({});
    }) as typeof fetch;
  });

  it('greets the user, lists recent projects and offers every tool', async () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Launch teaser')).toBeInTheDocument();
    expect(screen.getByText(/Good to see you, Seb/)).toBeInTheDocument();
    for (const name of ['Image editor', 'Video editor', 'Recense', 'Animation maker', 'Code Grounds', 'Document', 'Slideshow']) expect(screen.getByRole('button', { name: new RegExp(name) })).toBeInTheDocument();
    // No chat box: the dashboard is calm by design.
    expect(screen.queryByRole('textbox', { name: /chat|message|ask/i })).toBeNull();
  });
});
