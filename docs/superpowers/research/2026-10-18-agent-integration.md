# Agent integration research (2026-10-18)

Sources fetched live 2026-10-18; local facts from this machine.

## Local install state
| Agent | Dir | CLI on PATH |
|---|---|---|
| Claude Code | ~/.claude yes | `claude` (~/.local/bin) |
| Codex | ~/.codex yes (config.toml has `[mcp_servers.*]`) | no `codex` CLI (Codex desktop app only) |
| Cursor | ~/.cursor yes (mcp.json, skills-cursor/) | `cursor` (editor) only; no `cursor-agent` |
| Gemini CLI | ~/.gemini MISSING | no `gemini` |
| OpenCode | ~/.config/opencode yes (opencode.json, skills/, AGENTS.md) | `opencode` (~/.opencode/bin) |
| Shared | ~/.agents/skills yes (19 skills; ~/.claude/skills entries are symlinks into it) | |
Existing ~/.claude.json top-level `mcpServers` holds `crm` (type http) and `rea` (command/args, no type).

## 1. Claude Code
Source: https://code.claude.com/docs/en/mcp , https://code.claude.com/docs/en/skills
```
claude mcp add --transport stdio --scope user [--env K=V] bx -- node /abs/path/bin.js mcp
claude mcp add-json --scope user bx '{"type":"stdio","command":"node","args":["/abs/path/bin.js","mcp"]}'
claude mcp remove bx --scope user ; claude mcp get bx ; claude mcp list
```
- Scopes: local (default; `~/.claude.json` projects["<path>"].mcpServers), project (`.mcp.json`), user (`~/.claude.json` top-level `mcpServers`).
- Gotcha: `--env` swallows the next arg; put `--transport stdio` between `--env` and name.
- JSON entry: `{"type":"stdio","command":"node","args":["/abs/bin.js","mcp"],"env":{}}` (existing `rea` entry omits type; type optional for stdio in practice).
- Skills: `~/.claude/skills/<name>/SKILL.md`. No field strictly required; `description` recommended; `name` defaults to dir name. Frontmatter must start at line 1. Optional: when_to_use, disable-model-invocation, user-invocable, allowed-tools, paths, model, etc. description+when_to_use truncated at 1,536 chars. Reserved: folder `synced`, `anthropic-skills*`. Portable-to-claude.ai subset: name, description, license, compatibility, metadata, allowed-tools.
- Confidence: high. Installer tip: writing ~/.claude.json directly is risky (large, live-mutated file); prefer the CLI, fall back to JSON merge with atomic write.

## 2. OpenAI Codex
Sources: https://learn.chatgpt.com/docs/extend/mcp?surface=cli , /docs/build-skills , /docs/agent-configuration/agents-md (developers.openai.com/codex/* 308-redirects here)
- Config: `~/.codex/config.toml` (project: `.codex/config.toml`, trusted projects only).
- CLI: `codex mcp add <name> --env K=V -- <cmd...>`
```toml
[mcp_servers.bx]
command = "node"
args = ["/abs/path/bin.js", "mcp"]
startup_timeout_sec = 20   # default 10
tool_timeout_sec = 60      # default 60
enabled = true
[mcp_servers.bx.env]
KEY = "value"
```
- Skills: supported. Scanned: repo `.agents/skills` (cwd up to repo root), user `$HOME/.agents/skills`, admin `/etc/codex/skills`, bundled system. Docs do NOT mention ~/.codex/skills (Cursor docs claim Cursor reads ~/.codex/skills). SKILL.md must have `name` + `description`; optional `agents/openai.yaml`. Symlinked skill folders followed.
- Global instructions: `~/.codex/AGENTS.override.md` else `~/.codex/AGENTS.md` (first non-empty wins; `CODEX_HOME` overrides); project AGENTS.md walked root->cwd; 32 KiB cap (`project_doc_max_bytes`).
- Confidence: high on docs. Local config.toml had no existing stdio example I could confirm beyond node_repl/computer-use tables.

## 3. Cursor
Sources: https://cursor.com/docs/context/mcp , /skills , /rules
- Global MCP: `~/.cursor/mcp.json`; project `.cursor/mcp.json`.
```json
{"mcpServers":{"bx":{"type":"stdio","command":"node","args":["/abs/path/bin.js","mcp"],"env":{}}}}
```
Docs list `type` as required in field table but examples omit it (local blender entry has only command/args). Optional `envFile`. Interpolation: `${env:NAME}`, `${userHome}`, `${workspaceFolder}`. Include `type:"stdio"` to be safe.
- Skills: SUPPORTED. User: `~/.agents/skills/`, `~/.cursor/skills/`; also loads `~/.claude/skills/`, `~/.codex/skills/`, project `.agents/skills`, `.cursor/skills`, `.claude/skills`, `.codex/skills`. Frontmatter: `name` (required, lowercase/digits/hyphens, MUST match folder), `description` (required), optional paths, disable-model-invocation, icon, color, metadata.
- Rules (fallback): project `.cursor/rules/*.mdc` with `alwaysApply`/`globs`/`description`; plain .md ignored. User rules are UI-only (Customize > Rules), no global file. AGENTS.md supported in project root.
- Confidence: high (docs); note ~/.cursor/skills does not exist locally, only skills-cursor/ (built-ins).

## 4. Gemini CLI
Sources: https://geminicli.com/docs/tools/mcp-server/ , /docs/cli/skills/ , /docs/cli/gemini-md/
- Config `~/.gemini/settings.json` (project `.gemini/settings.json`).
```json
{"mcpServers":{"bx":{"command":"node","args":["/abs/path/bin.js","mcp"],"env":{},"cwd":"...","timeout":600000,"trust":false}}}
```
CLI: `gemini mcp add -s user [-e K=V] bx node /abs/path/bin.js mcp` (default scope is project; default transport stdio). timeout is ms, default 600000.
- Skills: SUPPORTED. User `~/.gemini/skills/` or alias `~/.agents/skills/` (`.agents` wins on collision); workspace `.gemini/skills/` or `.agents/skills/`. Frontmatter not documented on that page (name+description standard). `gemini skills install|list|uninstall`, `/skills enable|disable|link`. Extensions can also bundle skills.
- Context: `~/.gemini/GEMINI.md`; `context.fileName` can add AGENTS.md.
- WARNING: docs state Gemini CLI replaced by "Antigravity CLI" on 2026-06-18 for unpaid-tier/Google One users; treat gemini support as best-effort, only when ~/.gemini exists. Confidence medium.

## 5. OpenCode
Sources: https://opencode.ai/docs/mcp-servers/ , https://opencode.ai/docs/skills/
- Config `~/.config/opencode/opencode.json` (also .jsonc; both exist locally -- check which one the user uses; local opencode.json already has `mcp.blender`).
```json
{"mcp":{"bx":{"type":"local","command":["node","/abs/path/bin.js","mcp"],"enabled":true,"environment":{},"timeout":5000}}}
```
`timeout` = ms to fetch tools, default 5000 (raise, e.g. 15000). Command is a single array (no separate args). Optional `cwd`.
- Skills: SUPPORTED. Global: `~/.config/opencode/skills/<name>/SKILL.md`, `~/.claude/skills/`, `~/.agents/skills/`; project `.opencode/skills`, `.claude/skills`, `.agents/skills`. `name` regex `^[a-z0-9]+(-[a-z0-9]+)*$`, 1-64 chars, must equal dir name, unique across locations.
- Confidence: high; config-path precedence not stated on the MCP page.

## 6. Cross-agent standard dir: `~/.agents/skills/<name>/SKILL.md`
Read per docs by: Codex (user scope), Cursor, Gemini CLI, OpenCode. Claude Code docs only list `~/.claude/skills` (no ~/.agents) -> symlink `~/.claude/skills/<name>` -> `~/.agents/skills/<name>` (exactly what this machine already does). Cursor and OpenCode additionally read ~/.claude/skills (risk of duplicate-name conflicts: OpenCode requires unique names, Codex does not merge dupes). Recommendation: install real files in ~/.agents/skills, symlink only into ~/.claude/skills; skip other dirs. Use names matching `^[a-z0-9]+(-[a-z0-9]+)*$` equal to folder name with name+description frontmatter = valid for all five.

## 7. @modelcontextprotocol/sdk
Sources: https://github.com/modelcontextprotocol/typescript-sdk ; `npm view` on 2026-10-18.
- `@modelcontextprotocol/sdk` latest = **1.32.1** (v1.x, maintenance branch `v1.x`). peerDeps/deps: `zod ^3.25 || ^4.0`.
- **v2** is the repo `main`/"stable line": split packages `@modelcontextprotocol/server` (2.3.1) + `/client`; server dep `zod ^4.2.0`; uses Standard Schema (Valibot/ArkType OK); README imports `zod/v4`.
- **Zod conflict: project pin `zod ~3.24.4` is NOT satisfied by either** (v1 needs >=3.25, which ships the `zod/v4` subpath; v2 needs ^4.2). Must bump zod (3.25.x is the least change; zod latest 4.6.7).
- Minimal server, v1 (works with zod 3.25+):
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "bx", version: "0.1.0" });
server.registerTool("greet", { description: "Greet", inputSchema: { name: z.string() } },
  async ({ name }) => ({ content: [{ type: "text", text: `Hi ${name}` }] }));
await server.connect(new StdioServerTransport());
```
(v1 inputSchema is a raw zod shape object; confidence medium-high from memory of v1 API, not re-fetched.)
- v2 per README: `import { McpServer } from "@modelcontextprotocol/server"; import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"; inputSchema: z.object({name: z.string()})` with `zod/v4`. Confidence medium (summarized by fetch tool).
- stdio rule: never write to stdout except protocol; log to stderr.
