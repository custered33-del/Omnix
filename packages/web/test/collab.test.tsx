import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
