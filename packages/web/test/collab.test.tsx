import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { commentsContainer, createProjectState, makeNode, nodesOfType, primaryDocumentNodes, type CommentAnchor, type ProjectState, type SceneNode } from '@omnix/core';
import { createProjectStore, ProjectContext, type ProjectStore } from '../src/state/project.js';
import { CommentsPanel } from '../src/components/CommentsPanel.js';
import { anchorLabel, PinLayer } from '../src/components/CommentPins.js';
import { makeTextCommitter } from '../src/state/textCommitter.js';
import { useAuth } from '../src/state/auth.js';

function serve(state: ProjectState) {
  const meta = { id: 'p1', name: 'Launch', primaryTool: 'image', ownerId: 'u1', members: [], role: 'owner', aiConsent: true, archived: false, updatedAt: '', createdAt: '', thumbnailVersion: 0 };
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url) === '/api/projects/p1') return new Response(JSON.stringify({ project: meta, state, head: 'c0', proposals: [], snapshots: [], aiMarks: {} }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

async function storeFor(state: ProjectState): Promise<ProjectStore> {
  serve(state);
  useAuth.setState({ user: { id: 'u1', name: 'Seb', email: 'seb@example.com' } as never });
  const store = createProjectStore('p1');
  await store.getState().load();
  return store;
}

/** A project with an image, a video and a code file, plus comments pinned to each. */
function project() {
  let state = createProjectState({ id: 'p1', primaryTool: 'image' });
  const add = (nodes: SceneNode[], parentId: string) => {
    nodes[0]!.parentId = parentId;
    state = { ...state, nodes: { ...state.nodes, [parentId]: { ...state.nodes[parentId]!, children: [...state.nodes[parentId]!.children, nodes[0]!.id] }, ...Object.fromEntries(nodes.map((n) => [n.id, n])) } };
  };
  const video = primaryDocumentNodes('video', 'Teaser');
  add(video, state.rootId);
  const code = primaryDocumentNodes('code', 'Scripts');
  add(code, state.rootId);
  const file = makeNode('codeFile', { path: 'calc.py', language: 'python', content: 'a = 1\nb = 2\nprint(a + b)\n' });
  add([file], code[0]!.id);
  const canvas = nodesOfType(state, 'canvas')[0]!;
  const comment = (anchor: CommentAnchor, text: string, resolved = false) => {
    const c = makeNode('comment', { anchor, text, author: { type: 'human', id: 'u2', name: 'Ana' }, createdAt: new Date().toISOString(), resolved, replies: [] });
    add([c], commentsContainer(state).id);
    return c;
  };
  const onCanvas = comment({ tool: 'image', nodeId: canvas.id, x: 40, y: 30 }, 'Too dark here');
  const onVideo = comment({ tool: 'video', nodeId: video[0]!.id, time: 12.5 }, 'Cut earlier');
  const onLine = comment({ tool: 'code', nodeId: file.id, line: 3 }, 'Use an f-string');
  const done = comment({ tool: 'image', nodeId: canvas.id, x: 5, y: 5 }, 'Fixed already', true);
  return { state, canvas, sequence: video[0]!, workspace: code[0]!, file, onCanvas, onVideo, onLine, done };
}

describe('comments panel', () => {
  it('lists every open thread with where it points, and jumps to it', async () => {
    const p = project();
    const store = await storeFor(p.state);
    render(
      <ProjectContext.Provider value={store}>
        <CommentsPanel />
      </ProjectContext.Provider>,
    );
    expect(screen.getByText('Too dark here')).toBeInTheDocument();
    expect(screen.getByText('Teaser · At 0:12.5')).toBeInTheDocument();
    expect(screen.getByText(/· At 40, 30/)).toBeInTheDocument();
    expect(screen.getByText(/calc\.py, line 3/)).toBeInTheDocument();
    expect(screen.queryByText('Fixed already')).toBeNull();
    const filters = screen.getByRole('group', { name: 'Show comments' });
    await userEvent.click(within(filters).getByRole('button', { name: /Resolved/ }));
    expect(screen.getByText('Fixed already')).toBeInTheDocument();
    await userEvent.click(within(filters).getByRole('button', { name: /Open/ }));

    // "Show" opens the right document and asks it to go to the moment or line.
    const showButtons = screen.getAllByRole('button', { name: /Show/ });
    await userEvent.click(showButtons[1]!);
    expect(store.getState().activeDocId).toBe(p.sequence.id);
    expect(store.getState().focusRequest).toMatchObject({ documentId: p.sequence.id, time: 12.5, commentId: p.onVideo.id });
    await userEvent.click(showButtons[2]!);
    expect(store.getState().activeDocId).toBe(p.workspace.id);
    expect(store.getState().focusRequest).toMatchObject({ documentId: p.workspace.id, nodeId: p.file.id, line: 3 });

    // Comment mode toggles from the panel.
    await userEvent.click(screen.getByRole('button', { name: 'Add a comment' }));
    expect(store.getState().commentMode).toBe(true);
  });

  it('describes anchors in words', async () => {
    const p = project();
    expect(anchorLabel(p.state, p.onLine.props.anchor)).toBe('calc.py, line 3');
    expect(anchorLabel(p.state, p.onVideo.props.anchor)).toBe('At 0:12.5');
    expect(anchorLabel(p.state, { tool: 'image', nodeId: 'gone' })).toBe('On Deleted item');
  });
});

describe('pins on editor surfaces', () => {
  it('numbers pins, opens a thread, and pins a new comment where you clicked', async () => {
    const p = project();
    const store = await storeFor(p.state);
    const onCompose = vi.fn();
    const pins = [p.onCanvas].map((c) => ({ comment: c, x: c.props.anchor.x!, y: c.props.anchor.y! }));
    const { rerender } = render(
      <ProjectContext.Provider value={store}>
        <PinLayer label="Comments" pins={pins} composer={null} onCompose={onCompose} onCancelCompose={() => {}} />
      </ProjectContext.Provider>,
    );
    const pin = screen.getByRole('button', { name: 'Comment 1 by Ana' });
    await userEvent.click(pin);
    expect(pin).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Too dark here')).toBeInTheDocument();

    rerender(
      <ProjectContext.Provider value={store}>
        <PinLayer label="Comments" pins={pins} composer={{ x: 100, y: 60, anchor: { tool: 'image', nodeId: p.canvas.id, x: 100, y: 60 } }} onCompose={onCompose} onCancelCompose={() => {}} />
      </ProjectContext.Provider>,
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Comment' }), 'Logo needs room');
    await userEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const added = Object.values(store.getState().state!.nodes).find((n) => n.type === 'comment' && (n as SceneNode<'comment'>).props.text === 'Logo needs room') as SceneNode<'comment'>;
    expect(added.props.anchor).toEqual({ tool: 'image', nodeId: p.canvas.id, x: 100, y: 60 });
    expect(added.props.author.name).toBe('Seb');
    expect(onCompose).toHaveBeenCalledWith(added.id);
  });
});

describe('line comments in code', () => {
  it('move with their line when someone types above them', async () => {
    vi.useFakeTimers();
    try {
      const p = project();
      const store = await storeFor(p.state);
      const text = makeTextCommitter(store, 100);
      text.edit(p.file.id, 'content', '# totals\na = 1\nb = 2\nprint(a + b)\n', 'Edit calc.py');
      vi.advanceTimersByTime(150);
      const s = store.getState().state!;
      expect((s.nodes[p.file.id] as SceneNode<'codeFile'>).props.content.startsWith('# totals')).toBe(true);
      expect((s.nodes[p.onLine.id] as SceneNode<'comment'>).props.anchor.line).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('compare versions', () => {
  it('shows a paragraph edit inline and pictures of a canvas in four modes', async () => {
    const p = project();
    const store = await storeFor(p.state);
    const docComparison = {
      documentId: 'doc_1',
      kind: 'document',
      name: 'Brief',
      existsBefore: true,
      existsAfter: true,
      structural: { added: [], removed: [], changed: [{ id: 'b1', type: 'block', name: 'Revenue', props: ['text'], before: {}, after: {}, moved: false, reordered: false }], empty: false },
      blocks: [
        { status: 'same', blockId: 'b0', blockType: 'heading', after: 'Plan' },
        { status: 'changed', blockId: 'b1', blockType: 'paragraph', before: 'grew 12%', after: 'grew 14%', words: [{ kind: 'same', text: 'grew ' }, { kind: 'removed', text: '12' }, { kind: 'added', text: '14' }, { kind: 'same', text: '%' }] },
      ],
      summary: '1 paragraph edited',
    };
    const canvasComparison = { documentId: p.canvas.id, kind: 'canvas', name: 'Poster', existsBefore: true, existsAfter: true, structural: { added: [], removed: [], changed: [], empty: true }, summary: 'No changes' };
    const base = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      if (u.startsWith('/api/projects/p1/history')) return new Response(JSON.stringify({ commits: [], tips: [] }), { status: 200 });
      if (u.startsWith('/api/projects/p1/compare/pixels')) return new Response(JSON.stringify({ fraction: 0.125, bbox: { x: 1, y: 1, width: 4, height: 4 }, width: 400, height: 300 }), { status: 200 });
      if (u.startsWith('/api/projects/p1/compare?')) return new Response(JSON.stringify({ from: { commitId: 'c1', label: 'Draft 1', at: null }, to: { commitId: 'c2', label: 'Current version', at: null }, comparison: { documents: [docComparison, canvasComparison], changed: ['doc_1'], summary: 'Brief: 1 paragraph edited' } }), { status: 200 });
      return base(url, init);
    }) as typeof fetch;
    const { CompareVersions } = await import('../src/components/CompareVersions.js');
    render(
      <ProjectContext.Provider value={store}>
        <CompareVersions from="snap_1" to="current" documentId="doc_1" onClose={() => {}} />
      </ProjectContext.Provider>,
    );
    expect(await screen.findByText('Brief: 1 paragraph edited', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('12', { selector: 'del' })).toBeInTheDocument();
    expect(screen.getByText('14', { selector: 'ins' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 unchanged paragraph' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /Poster/ }));
    expect(await screen.findByText('12.5% of the picture changed')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Draft 1' }).getAttribute('src')).toContain('which=before');
    await userEvent.click(screen.getByRole('button', { name: /Swipe/ }));
    expect(screen.getByRole('slider', { name: 'Swipe between versions' })).toHaveValue('50');
    await userEvent.click(screen.getByRole('button', { name: /Difference/ }));
    expect(screen.getByRole('img', { name: '12.5% of the picture changed' }).getAttribute('src')).toContain('which=diff');
    expect(urls.some((u) => u.includes(`/compare/pixels?from=snap_1&to=current&node=${p.canvas.id}`))).toBe(true);
  });
});

describe('asset library', () => {
  it('flags similar files, merges a group and tags several files at once', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const { AssetsPage } = await import('../src/pages/AssetsPage.js');
    const asset = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, kind: 'image', mime: 'image/png', size: 1000, width: 100, height: 60, tags: [], autoTags: ['landscape', 'blue'], createdAt: new Date().toISOString(), hasThumbnail: true, usedIn: [], ...extra });
    const a = asset('a'.repeat(64), 'hills.png', { usedIn: [{ projectId: 'p1', projectName: 'Launch', count: 2 }] });
    const b = asset('b'.repeat(64), 'hills-web.jpg');
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: u, body });
      if (u.startsWith('/api/assets?')) return new Response(JSON.stringify({ total: 2, tags: [], autoTags: ['blue', 'landscape'], similarGroups: 1, assets: [a, b] }), { status: 200 });
      if (u === '/api/assets/similar') return new Response(JSON.stringify({ groups: [[a, b]] }), { status: 200 });
      if (u === '/api/assets/merge') return new Response(JSON.stringify({ kept: a.id, merged: [b.id], projects: [{ projectName: 'Launch', replaced: 1, status: 'committed' }] }), { status: 200 });
      if (u === '/api/assets/bulk') return new Response(JSON.stringify({ changed: 2 }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    render(
      <MemoryRouter>
        <AssetsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('1 group of files look like copies of each other.')).toBeInTheDocument();
    expect(screen.getByText('In 1 project')).toBeInTheDocument();
    expect(screen.getByText('Not used in any project')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Similar files' });
    // The second copy can be chosen as the one to keep.
    await userEvent.click(within(dialog).getAllByRole('radio')[1]!);
    await userEvent.click(within(dialog).getByRole('button', { name: /Merge into the kept file/ }));
    expect(calls.find((c) => c.url === '/api/assets/merge')!.body).toEqual({ keep: b.id, drop: [a.id] });
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: /Select/ }));
    await userEvent.click(screen.getByRole('button', { name: 'hills.png' }));
    await userEvent.click(screen.getByRole('button', { name: 'hills-web.jpg' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: 'Tag selected' }), 'hero{Enter}');
    expect(calls.find((c) => c.url === '/api/assets/bulk')!.body).toEqual({ ids: [a.id, b.id], addTags: ['hero'] });
  });
});

describe('batch dialog', () => {
  it('offers only operations that fit, builds the settings form and follows the run', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const { BatchDialog } = await import('../src/components/BatchDialog.js');
    const operations = [
      { id: 'image.resize', label: 'Resize', description: 'Fit pictures', group: 'image', ai: false, kinds: ['image'], params: { type: 'object', properties: { width: { type: 'integer', minimum: 16, maximum: 8000 }, mode: { type: 'string', enum: ['fit', 'fill'], default: 'fit' } }, required: ['mode'] } },
      { id: 'image.upscale', label: 'Upscale', description: 'Enlarge', group: 'image', ai: true, kinds: ['image'], params: { type: 'object', properties: {}, required: [] } },
      { id: 'audio.convert', label: 'Convert audio', description: 'mp3', group: 'audio', ai: false, kinds: ['audio'], params: { type: 'object', properties: {} } },
      { id: 'document.export', label: 'Export', description: 'files', group: 'document', ai: false, documentTypes: ['canvas'], params: { type: 'object', properties: {} } },
    ];
    let polls = 0;
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u === '/api/batch/operations') return new Response(JSON.stringify({ operations }), { status: 200 });
      if (u === '/api/batch') return new Response(JSON.stringify({ job: { id: 'job_1', title: 'Resize · 2 items', status: 'running', progress: 0, message: 'Starting', error: null, items: [] } }), { status: 202 });
      if (u === '/api/batch/job_1') {
        polls++;
        const done = polls > 1;
        return new Response(JSON.stringify({ job: { id: 'job_1', title: 'Resize · 2 items', status: done ? 'done' : 'running', progress: done ? 1 : 0.5, message: 'Resize: b.png', error: null, items: [{ target: { assetId: 'a' }, label: 'a.png', result: { status: 'done', outputAssetId: 'x'.repeat(64), outputName: 'a-640.png' } }, { target: { assetId: 'b' }, label: 'b.png', result: done ? { status: 'failed', message: 'Too large' } : null }] } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const onFinished = vi.fn();
    render(
      <MemoryRouter>
        <BatchDialog targets={[{ assetId: 'a' }, { assetId: 'b' }]} kinds={['image']} onClose={() => {}} onFinished={onFinished} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('radio', { name: /Resize/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Upscale/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Convert audio/ })).toBeNull();
    expect(screen.queryByRole('radio', { name: /Export/ })).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: /Resize/ }));
    await userEvent.type(screen.getByRole('spinbutton', { name: /Width/ }), '640');
    expect(screen.getByRole('combobox', { name: 'Mode' })).toHaveValue('fit');
    await userEvent.type(screen.getByRole('textbox', { name: 'Tag the new files' }), 'web, small');
    await userEvent.click(screen.getByRole('button', { name: 'Resize · 2 items' }));
    expect(calls.find((c) => c.url === '/api/batch')!.body).toEqual({ operation: 'image.resize', params: { mode: 'fit', width: 640 }, targets: [{ assetId: 'a' }, { assetId: 'b' }], tags: ['web', 'small'] });
    expect(await screen.findByText('a-640.png', { exact: false })).toBeInTheDocument();
    expect(await screen.findByText('Too large')).toBeInTheDocument();
    expect(screen.getByText('1 done · 1 failed')).toBeInTheDocument();
    expect(onFinished).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Show the new files' })).toHaveAttribute('href', '/assets?q=tag%3Aweb');
  });
});

describe('presets menu', () => {
  it('applies a preset to the target and saves the current look as a new one', async () => {
    const { MemoryRouter } = await import('react-router-dom');
    const { PresetMenu, invalidatePresets } = await import('../src/components/PresetMenu.js');
    invalidatePresets();
    const p = project();
    const store = await storeFor(p.state);
    const calls: { url: string; body: unknown }[] = [];
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u === '/api/presets?kind=clip-effects') return new Response(JSON.stringify({ presets: [{ id: 'builtin-clip-warm-film', kind: 'clip-effects', name: 'Warm film', description: '', builtIn: true, appliesTo: ['clip'], data: {} }, { id: 'pre_1', kind: 'clip-effects', name: 'Teal', description: '', builtIn: false, appliesTo: ['clip'], by: 'Ana', shared: true, mine: false, data: {} }] }), { status: 200 });
      if (u === '/api/projects/p1/presets/apply') return new Response(JSON.stringify({ commitId: 'c9', changed: 3 }), { status: 200 });
      if (u === '/api/presets') return new Response(JSON.stringify({ preset: { id: 'pre_2' } }), { status: 201 });
      return base(url, init);
    }) as typeof fetch;
    render(
      <MemoryRouter>
        <ProjectContext.Provider value={store}>
          <PresetMenu kind="clip-effects" targetId={p.sequence.id} sourceId="clp_1" canEdit />
        </ProjectContext.Provider>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Clip looks' }));
    expect(await screen.findByRole('menuitem', { name: /Teal · Ana/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /Warm film/ }));
    expect(calls.find((c) => c.url.endsWith('/presets/apply'))!.body).toEqual({ presetId: 'builtin-clip-warm-film', targetId: p.sequence.id });
    const { useToasts } = await import('../src/ui/toast.js');
    await waitFor(() => expect(useToasts.getState().items.map((x) => x.message)).toContain('Applied "Warm film" (3 changes)'));

    await userEvent.click(screen.getByRole('button', { name: 'Clip looks' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Save current/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Dusk');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(calls.find((c) => c.url === '/api/presets')!.body).toEqual({ name: 'Dusk', description: '', shared: false, from: { projectId: 'p1', nodeId: 'clp_1' } });
  });
});
