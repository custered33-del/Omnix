# Writing an Omnix plugin

A plugin adds tools to Omnix. Plugin tools use the same schema as Omnix's own MCP tools: a name, a description, a JSON Schema for the input, and annotations. Once installed, a plugin's tools are available in three places:

- **Claude**, connected over MCP, sees them in Omnix's tool list as `<plugin>__<tool>`.
- **The built-in agent runner** can use them during an autonomous run.
- **People** can run them from the **Plugins** panel in any project. The panel builds a form from the tool's schema.

Tools that take a single library file (`assetId`) or a single document (`projectId` and `documentId`) also appear as **batch operations**, so they can run over many files or documents at once.

There are three kinds of plugin:

| Kind | What it is | How it is installed |
| --- | --- | --- |
| `mcp-http` | Any MCP server reachable over Streamable HTTP | **Settings → Plugins → Add an MCP server** (server owner), or a folder |
| `mcp-stdio` | An MCP server started as a command, speaking MCP over stdin/stdout | A folder in the plugins folder |
| `local` | A JavaScript module that exports tools in the MCP shape | A folder in the plugins folder |

Plugins that run code on the server (`mcp-stdio` and `local`) can only be installed by someone with access to the server's file system. The plugins folder is `OMNIX_PLUGINS_DIR` (default `<data folder>/plugins`). Each plugin is a subfolder containing an `omnix-plugin.json`:

```json
{
  "name": "Palette",
  "description": "Suggest colors and add swatches to a canvas.",
  "type": "mcp-stdio",
  "command": "node",
  "args": ["server.mjs"]
}
```

For `mcp-http` use `"url"` (and optionally `"headers"`). For `local` use `"entry": "index.mjs"`. Omnix starts plugins in the background, so a slow or broken plugin never delays startup. **Settings → Plugins** shows each plugin's status and any error. From there you can turn a plugin off, reconnect it, or remove one that was added there.

## Tools

A tool is an ordinary MCP tool:

```json
{
  "name": "add_swatches",
  "title": "Add swatches to a canvas",
  "description": "Add a row of color swatches (one shape layer) to a canvas.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "projectId": { "type": "string" },
      "canvasId": { "type": "string" },
      "colors": { "type": "array", "items": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" } }
    },
    "required": ["projectId", "canvasId", "colors"]
  },
  "annotations": { "readOnlyHint": false, "destructiveHint": false }
}
```

- **Input checks.** Omnix validates every call against the input schema before your tool runs. Bad arguments never reach you.
- **Read-only tools.** Mark tools that change nothing with `readOnlyHint: true`. View-only Claude connections can use only those.
- **Tools that only add.** A tool that changes things is treated as one that may also remove them, as MCP specifies, unless it says `destructiveHint: false`. During an autonomous run with the "before deleting" approval (the default), every call to such a tool waits for the person's approval first. Declare `destructiveHint: false` on tools that only add or edit, so runs are not interrupted needlessly.
- **Forms in the Plugins panel.** These argument names get special treatment:
  - `projectId` is filled in automatically.
  - `canvasId`, `sequenceId`, `deckId`, `workspaceId` and `documentId` become pickers of the project's documents.
  - Names ending in `AssetId` pick a file from the library.
  - Enums become choices, numbers keep their limits, and arrays of `#rrggbb` strings become color pickers.

## What your tool is told

Each call carries the caller's context. MCP plugins receive it as `_meta["omnix/context"]`; local plugins receive it as the handler's second argument:

```json
{
  "user": { "id": "usr_…", "name": "Seb" },
  "projectId": "prj_…",
  "project": { "name": "Launch", "documents": [ … ], "notes": [ … ], "openComments": 2 },
  "omnixUrl": "https://omnix.example.com",
  "via": "mcp"
}
```

When the call names a project the caller can read, `project` is the same outline `get_project` returns. It covers every document: layers, clips, slides, code files, and the headings of documents with their block ids.

## Changing projects

Plugins never write to projects directly. Instead, a tool result can carry an `omnix` object in its `structuredContent`:

```json
{
  "content": [{ "type": "text", "text": "Adding 3 swatches." }],
  "structuredContent": {
    "omnix": {
      "projectId": "prj_…",
      "label": "Add 3 palette swatches",
      "operations": [
        { "kind": "create", "parentId": "cnv_…", "nodes": [{ "type": "layer", "props": { "name": "Palette", "layerType": "vector", "shapes": [ … ] } }] }
      ],
      "assets": [{ "name": "palette.png", "mimeType": "image/png", "data": "<base64>" }]
    }
  }
}
```

- **Operations** are Omnix's own operation types: `create`, `update`, `delete`, `move`, `listInsert`, `listRemove`, `listUpdate` and `batch`. The same types appear in `apply_operations` in the [tool catalog](MCP_TOOLS.md).
  - For new nodes, `type` and the properties you care about are enough. Omnix fills in ids, links and every other property's default, then validates the operations.
  - They apply under the caller's permission mode. An approval-mode connection gets a proposal to review; an autonomous one or a person gets a commit. Either way the change is attributed to the caller and can be undone.
  - A plugin cannot get around review.
- **Assets** are saved to the caller's library, tagged `plugin` and with the plugin's name. To place a returned file, write `{{asset:0}}` (the first asset), `{{asset:1}}` and so on in your operations. Omnix replaces them with the new asset ids before applying.
- **Images** in `content` are shown to Claude and in the Plugins panel.

Everything else in `structuredContent` is passed back to the caller unchanged.

## A local plugin

```js
// plugins/word-tools/index.mjs
export default {
  name: 'Word tools',
  tools: [
    {
      name: 'list_headings',
      title: 'List headings',
      description: 'The headings of a document.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, documentId: { type: 'string' } }, required: ['projectId', 'documentId'] },
      annotations: { readOnlyHint: true },
      handler(args, context) {
        const doc = context.project.documents.find((d) => d.id === args.documentId);
        return { content: [{ type: 'text', text: doc.outline.map((h) => h.text).join('\n') }] };
      },
    },
  ],
};
```

## Examples

[`examples/plugins`](../examples/plugins) has two working plugins, both used by the test suite:

- **palette** is an MCP server written in plain Node with no dependencies. It speaks JSON-RPC over stdio directly, which shows that any language works. It suggests palettes, adds swatches to a canvas (returning operations), and makes a swatch image (returning an asset).
- **word-tools** is a local module. It title-cases a document's headings (returning operations) and lists them. Because it takes `{ projectId, documentId }`, it also runs as a batch over many documents.

To try them, copy both folders into your plugins folder and restart Omnix.
