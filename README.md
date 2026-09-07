# Overdare MCP

An [MCP](https://modelcontextprotocol.io) server that lets AI agents (Claude
Code / Claude Desktop) drive **OVERDARE Studio** — browse the DataModel, create
and edit instances, write Luau scripts, and start playtests.

## How it works

OVERDARE Studio already hosts a local JSON-RPC server (the same one its built-in
"diligent" agent uses). This MCP server is a thin bridge to it — much like
`unity-mcp`'s connector, except **Studio hosts the local server itself**, so
there's no plugin to install.

```
Claude  ──stdio──▶  overdare-mcp  ──raw TCP──▶  Studio RPC        (127.0.0.1:13377)
                                  ──HTTP────▶  UE Remote Control (127.0.0.1:30010)
                                                  └─ OVERDARE Studio (must be running)
```

Port 13377 is **not** HTTP. It is newline-delimited JSON-RPC 2.0 straight over a
TCP socket, one connection per call — speaking HTTP at it yields a protocol
violation instead of a response. Remote Control on 30010 *is* HTTP, and is a
separate surface (the `overdare_rc_*` tools) that reaches the Unreal editor
underneath rather than the OVERDARE DataModel.

> Studio must be open with a project for tools to work. If Studio isn't running,
> tools return a clear "cannot reach Studio" error instead of hanging.

## Setup

```bash
npm install
npm run build
```

Verify the connection (open OVERDARE Studio first):

```bash
npm run probe                                   # smoke test + level.browse
npm run probe -- instance.read '{"path":"Workspace.Baseplate"}'   # inspect any method
```

## Register with Claude Code

Add to `.mcp.json` in your project (an example is included in this repo):

```json
{
  "mcpServers": {
    "overdare": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/overdare-mcp/dist/index.js"]
    }
  }
}
```

For **Claude Desktop**, add the same block under `mcpServers` in
`claude_desktop_config.json`.

### Configuration (env vars)

| Var | Default | Purpose |
| --- | --- | --- |
| `STUDIO_HOST` | `localhost` | Studio RPC host (`STUDIO_RPC_HOST` also accepted) |
| `STUDIO_PORT` | `13377` | Studio RPC port (`STUDIO_RPC_PORT` also accepted) |
| `STUDIO_RPC_TIMEOUT_MS` | `10000` | Per-call timeout |
| `OVERDARE_PROJECT_DIR` | auto-detected | Fallback project directory for the file-backed tools |
| `OVERDARE_BLENDER` | auto-detected | Blender executable used by `overdare_mesh_prepare` |

## Tools

Three backends sit behind these, and the difference matters when something
fails. **RPC** talks to Studio live over 13377. **File** edits the saved
`.ovdrjm` and asks Studio to reload, which is how the tools whose RPC method
does not exist are implemented — stop any playtest before using those. **RC**
is Unreal Remote Control on 30010.

### Reading

| Tool | Via | Purpose |
| --- | --- | --- |
| `overdare_browse` | RPC `level.browse` | Browse the DataModel tree. Start here — everything else targets `guid` |
| `overdare_find` | File | Search by name substring and/or class; far more practical than browsing a large project |
| `overdare_read_instance` | File | Read one instance's properties as saved |
| `overdare_script_read` | File | Read a script's Luau source |
| `overdare_validate_lua` | luau-lsp | Type-check scripts against the OVERDARE type definitions |
| `overdare_status` | — | Report what is reachable and configured |

`overdare_validate_lua` runs the `luau-lsp` and `overdare-types.d.lua` that ship
beside Studio's bundled agent, so it knows the real API surface — it will tell
you that `Key 'Bold' not found in external type 'TextLabel'`, which is exactly
the kind of break an engine update causes and that otherwise only shows up as a
runtime warning in `Sandbox.log`. It takes scripts already in the project (by
GUID or dotted path, as `overdare_find` reports them) or files on disk.

Its blind spot is worth knowing: a local from `Instance.new("TextLabel")` is not
narrowed to `TextLabel`, so property errors on that local go unreported. Annotate
the local, or check the value at runtime with `overdare_observe`.

### Editing

| Tool | Via | Purpose |
| --- | --- | --- |
| `overdare_create_part` | File | Create a Part |
| `overdare_create_instance` | File | Create one instance of any class |
| `overdare_create_instances` | File | Bulk-create under one parent in a single reload |
| `overdare_update_instance` | File | Change properties and/or rename |
| `overdare_move_instance` | File | Reparent |
| `overdare_duplicate_instance` | File | Copy a subtree with fresh GUIDs |
| `overdare_delete_instance` | File | Delete by GUID |
| `overdare_instance_create` | RPC `instance.create` | Create live, under one parent, no reload |
| `overdare_instance_update` | RPC `instance.update` | Change properties live, no reload |
| `overdare_instance_delete` | RPC `instance.delete` | Delete live, without a reload |
| `overdare_script_add` | File | Create a Script / LocalScript / ModuleScript |
| `overdare_script_edit` | File | Replace a script's source, or toggle `Enabled` |

Prefer the RPC three when you are iterating: the file-backed tools rewrite the
project and ask Studio to reload, so they need the playtest stopped, while these
go to the running editor. Two things about them are worth knowing before you
trust a result:

- **Properties go flat.** Nesting them under a `Properties` key does not fail —
  the call succeeds, `message` says `Properties is not a valid property of
  Frame`, and every value is dropped. Same for a misspelled property name: a
  `[WARNING]` in `message`, not an error. Read `message`.
- **A class this build lacks is not an error either.** The call succeeds and
  returns fewer GUIDs than you asked for. `overdare_instance_create` pairs them
  back up and reports `guid: null` per instance. `UICorner`, `UIGradient`,
  `UIPadding`, `UISizeConstraint`, `UITextSizeConstraint`, `ViewportFrame`,
  `TextBox`, `CanvasGroup` and `VideoFrame` are all absent; `UIStroke`,
  `UIListLayout`, `UIGridLayout`, `UIAspectRatioConstraint`, `ProgressBar` and
  `ScrollingFrame` are present.

Composite property values are tagged objects, and `UDim2` spells its second axis
with a lower-case `y` — an upper-case `Y` is silently dropped. Rather than write
those by hand, pass the array short forms (`Size: [0.5, 10, 0, 64]`,
`BackgroundColor3: [20, 180, 90]`, `AnchorPoint: [0.5, 1]`); see `src/props.ts`.

### Project lifecycle

| Tool | Via | Purpose |
| --- | --- | --- |
| `overdare_save` | RPC `level.save.file` | Save the project to disk |
| `overdare_apply` | RPC `level.apply` | Reload pending level changes |
| `overdare_publish` | RPC `level.publish` | Publish to the Hub (owner only) |
| `overdare_set_project` | — | Re-detect or pin the project directory |

### Playtest and viewport

| Tool | Via | Purpose |
| --- | --- | --- |
| `overdare_play` / `overdare_stop` | RPC `game.play` / `game.stop` | Start / stop a playtest |
| `overdare_screenshot` | RPC `game.screenshot` | Capture the viewport and return the image. UI is included; `locate` projects instances into click coordinates |
| `overdare_camera` | RC | Aim the editor camera before a screenshot |
| `overdare_viewport` | RC | Read or change how the editor viewport renders |

### Runtime observation

Only meaningful while a playtest is running. A screenshot shows pixels and the
saved project shows what was authored; neither shows what the running game
currently holds, which is where UI bugs live — a label a script rewrote, a frame
a layout pushed off screen, a button buried under a higher `ZIndex`.

| Tool | Via | Purpose |
| --- | --- | --- |
| `overdare_pie_status` | RPC `game.pie.status` | Is a playtest running, and which clients take input |
| `overdare_ui_browse` | RPC `game.ui.browse` | The live UI as flat elements: path, class, text, normalized rect, visibility |
| `overdare_observe` | RPC `game.observe` | Character, UI, and live instance state in one game-thread read |
| `overdare_character_read` | RPC `game.character.read` | CFrame, speed, facing, what it stands on |
| `overdare_input_inject` | RPC `game.input.inject` | Keys, pointer, look, scroll, waits — up to 64 events |

Two things the underlying method does not tell you, which the tool handles:

- `pieSessionId` and `clientId` are **mandatory** on the wire. Omitting either
  fails the batch with the same `Invalid input event` as a malformed event, so
  `overdare_input_inject` resolves both from `game.pie.status` when you leave
  them out.
- `action: "press"` is documented but **rejected** by this build; only
  `down`/`up` are accepted. The tool expands `press` into a `down`/`wait`/`up`
  triple so the short form still works.

Pointer events only land on the part of the viewport that lies inside the Studio
window. When the window hangs off screen the reachable region shrinks — sometimes
to a sliver — and `overdare_ui_browse` reports it under `viewport.reachable`.
The game still renders the whole frame, so a screenshot looks fine while a click
at those coordinates goes nowhere.

### Assets

| Tool | Via | Purpose |
| --- | --- | --- |
| `overdare_assets` | — | List the curated Asset Drawer catalog |
| `overdare_asset_import` | RPC | Import an Asset Drawer model by id |
| `overdare_image_import` | RPC | Import a local PNG/JPG into the asset manager |
| `overdare_mesh_prepare` | Blender | Make a 3D file import-ready (see below) |
| `overdare_mesh_bulk_import` | GUI | Drive many prepared meshes through the import dialog |
| `overdare_engine_assets` | RC | Query the engine asset registry |
| `overdare_rc_search_assets` | RC | Search the Unreal asset library |

### Unreal Remote Control (low level)

| Tool | Purpose |
| --- | --- |
| `overdare_rc_call` | Call a UFunction on an Unreal object |
| `overdare_rc_property` | Read or write a property |
| `overdare_rc_describe` | Describe an object's properties and functions |
| `overdare_rc_list_actors` / `overdare_actors` | Enumerate live actors and their object paths |
| `overdare_selection` | Read or change the editor's actor selection |
| `overdare_console` | Run a console command or read a cvar |
| `overdare_rc_batch` | Several RC requests in one round-trip |
| `overdare_rc_python` | Run an Unreal Python command |

`overdare_rc_batch` and `overdare_rc_python` do not work against a shipping
Studio build: `PUT /remote/batch` has crashed Studio outright, and
`ExecutePythonCommand` returns 400 because the Python plugin is not loaded.
They are kept for builds that do support them.

### Escape hatch

| Tool | Purpose |
| --- | --- |
| `overdare_rpc` | Call any Studio RPC method with raw params |
| `overdare_recipe` | Read a build recipe adapted from the built-in agent's skills |

## Smart mesh import (`overdare_mesh_prepare`)

OVERDARE caps imported meshes at **30,000 triangles per mesh** and recommends
**512px** textures (large 4K textures OOM the importer). `overdare_mesh_prepare`
runs **headless Blender** to make any `.fbx / .obj / .glb / .gltf / .blend`
import-ready:

- decimates an over-budget mesh to fit the triangle limit,
- downscales & re-embeds textures to the target size,
- writes a self-contained `<name>_overdare.fbx`.

The final Import into Studio (Home ▸ Import) is still a manual GUI step. Requires
Blender installed — Steam installs are auto-detected; set `OVERDARE_BLENDER` to
override the path.

## Switching projects (`overdare_set_project`)

The `.ovdrjm` file-edit tools now **auto-follow whichever project is open in
Studio** (recovered from its screenshot path). After switching projects in
Studio, call `overdare_set_project` with no args to re-detect, or pass a `dir` to
pin a specific project directory. `OVERDARE_PROJECT_DIR` remains a fallback.

## Which RPC methods actually exist

Method names were originally read out of the Studio runtime, and several of them
turned out not to be dispatchable. Probed against a live Studio (2026-09-07):

**Present.** `level.browse` · `level.apply` · `level.save.file` ·
`level.publish` · `instance.create` · `instance.update` · `instance.read` ·
`instance.move` · `instance.delete` · `game.play` · `game.stop` ·
`game.screenshot` · `game.observe` · `game.ui.browse` · `game.pie.status` ·
`game.character.read` · `game.input.inject` · `viewport.camera.read` ·
`viewport.camera.set` · `hub.token.read`

**Absent** — these return `-32601`, so anything routed to them fails: every
`script.*` method, `instance.upsert`, `procedural.run`, the asset-import
methods, and `validatelua`. They belong to the bundled agent, not to the RPC
surface. The script and instance tools here go through the project file instead,
which is why they carry the "stop the playtest first" caveat.

There is no discovery method — `rpc.discover` and `system.listMethods` are both
absent. To check whether a method exists, call it with empty params and read the
error: `-32601` means no such method, anything else means it is there.
`npm run probe -- <method> '<json>'` does this, and `overdare_rpc` is the
fallback for a method with no dedicated tool.
