// A local Omnix plugin: a module on the server that exports tools in the MCP shape. Each handler
// receives the arguments and Omnix's call context (who is calling, the project's outline) and
// returns an MCP result. Because title_case_headings takes { projectId, documentId }, Omnix also
// offers it as a batch operation over many documents.

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
const titleCase = (s) =>
  s
    .toLowerCase()
    .split(/(\s+)/)
    .map((w, i, all) => (/^\s+$/.test(w) || (SMALL.has(w) && i !== 0 && i !== all.length - 1) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');

function docOutline(context, documentId) {
  const doc = context.project?.documents?.find((d) => d.id === documentId);
  if (!doc || doc.tool !== 'document') throw new Error('Pick a document in this project.');
  return doc;
}

export default {
  name: 'Word tools',
  tools: [
    {
      name: 'title_case_headings',
      title: 'Title-case headings',
      description: 'Rewrite every heading in a document in title case ("the plan for q3" becomes "The Plan for Q3").',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, documentId: { type: 'string' } }, required: ['projectId', 'documentId'] },
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler(args, context) {
        const doc = docOutline(context, args.documentId);
        const changes = doc.outline.filter((h) => titleCase(h.text) !== h.text);
        return {
          content: [{ type: 'text', text: changes.length ? `Title-casing ${changes.length} heading(s).` : 'Every heading is already in title case.' }],
          structuredContent: changes.length ? { omnix: { label: 'Title-case headings', operations: changes.map((h) => ({ kind: 'update', id: h.id, set: { text: titleCase(h.text) } })) } } : {},
        };
      },
    },
    {
      name: 'list_headings',
      title: 'List headings',
      description: 'The headings of a document, with their levels.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, documentId: { type: 'string' } }, required: ['projectId', 'documentId'] },
      annotations: { readOnlyHint: true },
      handler(args, context) {
        const doc = docOutline(context, args.documentId);
        return { content: [{ type: 'text', text: doc.outline.map((h) => `${'#'.repeat(h.level)} ${h.text}`).join('\n') || 'No headings.' }], structuredContent: { headings: doc.outline } };
      },
    },
  ],
};
