import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createProjectState, layerProps, makeNode, nodesOfType, notesContainer, type ProjectState } from '@omnix/core';
import { createProjectStore, ProjectContext, type ProjectStore } from '../src/state/project.js';
import { realtime } from '../src/state/realtime.js';
import { CommandBar } from '../src/components/CommandBar.js';
import { AiMarker } from '../src/components/AiMarker.js';
import { NotesPanel } from '../src/components/NotesPanel.js';
import { RunCard, type AgentRun } from '../src/components/AgentRuns.js';
import { marginsForRatio } from '../src/components/GenerativeDialog.js';
import { useAuth } from '../src/state/auth.js';

/** A project store backed by a fake server that records requests. */
function setup(state: ProjectState, routes: Record<string, (body: unknown) => unknown> = {}) {
  const calls: { url: string; body: unknown }[] = [];
  const meta = { id: 'p1', name: 'Poster', primaryTool: 'image', ownerId: 'u1', members: [], role: 'owner', aiConsent: true, archived: false, updatedAt: '', createdAt: '', thumbnailVersion: 0 };
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, body });
    if (u === '/api/projects/p1') return new Response(JSON.stringify({ project: meta, state, head: 'c0', proposals: [], snapshots: [], aiMarks: {} }), { status: 200 });
    if (u === '/api/ai/capabilities') return new Response(JSON.stringify({ claude: false, imageProviders: [{ id: 'builtin', label: 'Built-in', generative: false }], commandExamples: { image: ['Make the sky warmer'] }, styleAspects: [] }), { status: 200 });
    for (const [k, fn] of Object.entries(routes)) if (u === k) return new Response(JSON.stringify(fn(body)), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return calls;
}

async function storeFor(state: ProjectState): Promise<ProjectStore> {
  const store = createProjectStore('p1');
  await store.getState().load();
  return store;
}

describe('command bar', () => {
  let state: ProjectState;
  beforeEach(() => {
    state = createProjectState({ id: 'p1', primaryTool: 'image' });
  });

  it('sends the command with the editor context and shows the steps to review', async () => {
    const calls = setup(state, { '/api/projects/p1/commands': () => ({ status: 'proposed', proposalId: 'prop_1', steps: ['Warmer: the sky', 'Move the title to the lower third'], unmatched: [{ clause: 'sparkle', reason: 'I didn’t understand "sparkle".' }] }) });
    const store = await storeFor(state);
    store.getState().setEditorContext({ slideId: null, time: 3.5 });
    const onReview = vi.fn();
    render(
      <ProjectContext.Provider value={store}>
        <CommandBar initialText="" autoRun={false} onClose={() => {}} onReview={onReview} />
      </ProjectContext.Provider>,
    );
    // Examples for the open editor appear as one-click chips.
    await userEvent.click(await screen.findByRole('button', { name: 'Make the sky warmer' }));
    expect(screen.getByRole('textbox', { name: 'Describe a change' })).toHaveValue('Make the sky warmer');
    await userEvent.clear(screen.getByRole('textbox', { name: 'Describe a change' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Describe a change' }), 'make the sky warmer and move the title to the lower third{Enter}');
    expect(await screen.findByText('Warmer: the sky')).toBeInTheDocument();
    expect(screen.getByText('Move the title to the lower third')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Not understood' })).toHaveTextContent('sparkle');
    const sent = calls.find((c) => c.url === '/api/projects/p1/commands')!.body as { text: string; documentId: string; time: number };
    expect(sent).toMatchObject({ text: 'make the sky warmer and move the title to the lower third', time: 3.5, documentId: nodesOfType(state, 'canvas')[0]!.id });
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalledWith('prop_1');
  });

  it('runs a command typed in the palette right away', async () => {
    const calls = setup(state, { '/api/projects/p1/commands': () => ({ status: 'not-understood', unmatched: [{ clause: 'zap it', reason: 'I didn’t understand "zap it".' }], examples: ['Remove the background'] }) });
    const store = await storeFor(state);
    render(
      <ProjectContext.Provider value={store}>
        <CommandBar initialText="zap it" autoRun onClose={() => {}} onReview={() => {}} />
      </ProjectContext.Provider>,
    );
    expect(await screen.findByText(/zap it/, { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/connect a Claude API key/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove the background' })).toBeInTheDocument();
    expect(calls.filter((c) => c.url === '/api/projects/p1/commands')).toHaveLength(1);
  });
});

describe('AI attribution and session memory', () => {
  it('marks nodes the AI changed and clears the mark when a person edits them', async () => {
    const state = createProjectState({ id: 'p1', primaryTool: 'image' });
    const canvas = nodesOfType(state, 'canvas')[0]!;
    setup(state);
    const store = await storeFor(state);
    const layer = makeNode('layer', layerProps('fill', { name: 'Glow' }));
    const emit = (msg: unknown) => (realtime as unknown as { emit(m: unknown): void }).emit(msg);
    emit({ type: 'commit', projectId: 'p1', head: 'c1', commit: { id: 'c1', seq: 1, parentId: 'c0', op: { kind: 'create', parentId: canvas.id, nodes: [layer] }, inverse: { kind: 'delete', id: layer.id }, author: { type: 'ai', id: 'claude:x', name: 'Claude' }, timestamp: new Date().toISOString(), label: 'Add glow' } });
    render(
      <ProjectContext.Provider value={store}>
        <AiMarker nodeId={layer.id} />
      </ProjectContext.Provider>,
    );
    expect(screen.getByRole('img', { name: /Changed by Claude/ })).toBeInTheDocument();
    emit({ type: 'commit', projectId: 'p1', head: 'c2', commit: { id: 'c2', seq: 2, parentId: 'c1', op: { kind: 'update', id: layer.id, set: { name: 'Mine' } }, inverse: { kind: 'update', id: layer.id, set: { name: 'Glow' } }, author: { type: 'human', id: 'u1', name: 'Seb' }, timestamp: new Date().toISOString(), label: 'Rename' } });
    await waitFor(() => expect(screen.queryByRole('img', { name: /Changed by Claude/ })).toBeNull());
  });

  it('filters session memory by kind and labels automatic notes', async () => {
    let state = createProjectState({ id: 'p1', primaryTool: 'image' });
    const container = notesContainer(state);
    const notes = [
      makeNode('note', { kind: 'prompt', text: '“make it warmer”', author: { type: 'human', id: 'u1', name: 'Seb' }, createdAt: new Date().toISOString(), auto: true }),
      makeNode('note', { kind: 'rejected', text: 'Rejected "Neon palette": too loud', author: { type: 'human', id: 'u1', name: 'Seb' }, createdAt: new Date().toISOString(), auto: true }),
      makeNode('note', { kind: 'decision', text: 'Use the blue palette', author: { type: 'ai', id: 'claude:x', name: 'Claude' }, createdAt: new Date().toISOString() }),
    ];
    state = { ...state, nodes: { ...state.nodes, [container.id]: { ...container, children: notes.map((n) => n.id) }, ...Object.fromEntries(notes.map((n) => [n.id, { ...n, parentId: container.id }])) } };
    setup(state);
    useAuth.setState({ user: { id: 'u1', name: 'Seb', email: 'seb@example.com' } as never });
    const store = await storeFor(state);
    render(
      <ProjectContext.Provider value={store}>
        <NotesPanel />
      </ProjectContext.Provider>,
    );
    expect(screen.getAllByText(/recorded automatically/)).toHaveLength(2);
    const filters = screen.getByRole('group', { name: 'Show' });
    await userEvent.click(within(filters).getByRole('button', { name: /Rejected/ }));
    expect(screen.getByText(/too loud/)).toBeInTheDocument();
    expect(screen.queryByText('Use the blue palette')).toBeNull();
  });
});

describe('agent run card', () => {
  const run: AgentRun = {
    id: 'job_1',
    projectId: 'p1',
    title: 'Teaser',
    status: 'awaiting_approval',
    progress: 0.3,
    message: 'Waiting',
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    goal: 'Make a 30-second teaser',
    driver: 'internal',
    gates: [{ kind: 'plan' }],
    plan: [
      { title: 'Pick shots', status: 'done' },
      { title: 'Titles and music', status: 'active' },
    ],
    checkpoints: [{ id: 'cp_1', stage: 'Pick shots', summary: 'Five shots, 26 s.', snapshotId: 's1', head: 'c3', at: new Date().toISOString() }],
    pendingGate: { id: 'gate_2', kind: 'stage', title: 'Stage finished: Pick shots', summary: 'Five shots, 26 s.', at: new Date().toISOString() },
    decisions: [],
    log: [{ at: new Date().toISOString(), kind: 'tool', tool: 'video_add_clip', ok: true, text: 'Added a clip' }],
    steps: 4,
    maxSteps: 80,
    model: null,
    usage: { input: 1000, output: 100 },
    summary: null,
  };

  it('approves, asks for changes with feedback, and stops with a rollback choice', async () => {
    const calls = setup(createProjectState({ id: 'p1', primaryTool: 'video' }), { '/api/agent/runs/job_1/decision': () => ({ run }) });
    render(<RunCard run={run} focused={false} />);
    expect(screen.getByRole('list', { name: 'Plan' })).toHaveTextContent('Titles and music');
    const gate = screen.getByRole('group', { name: 'Stage finished: Pick shots' });
    await userEvent.click(within(gate).getByRole('button', { name: 'Ask for changes' }));
    await userEvent.type(screen.getByLabelText(/What should change/), 'Shorter shots');
    await userEvent.click(within(gate).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/agent/runs/job_1/decision')).toBe(true));
    expect(calls.find((c) => c.url === '/api/agent/runs/job_1/decision')!.body).toEqual({ decision: 'changes', feedback: 'Shorter shots' });
    await userEvent.click(within(gate).getByRole('button', { name: 'Stop' }));
    await userEvent.selectOptions(screen.getByLabelText('When stopping'), 'cp_1');
    await userEvent.click(within(gate).getAllByRole('button', { name: 'Stop' }).at(-1)!);
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/agent/runs/job_1/decision')).toHaveLength(2));
    expect(calls.filter((c) => c.url === '/api/agent/runs/job_1/decision')[1]!.body).toEqual({ decision: 'stop', rollbackTo: 'cp_1' });
  });
});

describe('generative extend', () => {
  it('computes margins that reach an aspect ratio around the picture', () => {
    expect(marginsForRatio(1000, 1000, 16, 9)).toEqual({ top: 0, bottom: 0, left: 389, right: 389 });
    expect(marginsForRatio(1920, 1080, 9, 16)).toEqual({ left: 0, right: 0, top: 1166, bottom: 1167 });
    const m = marginsForRatio(1080, 1350, 1, 1);
    expect(m.left + m.right + 1080).toBe(1350);
  });
});
