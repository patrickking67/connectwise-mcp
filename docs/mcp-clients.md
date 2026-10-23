# Running this server in every MCP client

One server, three shapes: a **local stdio** process (`dist/stdio.js`), the three **MCPB bundles**
that wrap it, and a **remote Streamable HTTP** endpoint (`dist/index.js`, deployed as an Azure
Container App). Which one a client can reach is the only thing that differs below.

Everywhere a path appears it must be **absolute**. MCP clients launch the server from their own
working directory, not yours, so `./dist/stdio.js` or `~/GitHub/...` will fail with
`MODULE_NOT_FOUND`. Print the right one once and paste it:

```bash
cd /path/to/connectwise-mcp && npm ci && npm run build && echo "$PWD/dist/stdio.js"
```

**The server always starts.** Since 0.4.0 it starts even with nothing configured, registering
`cw_status_server` alone — call that tool first whenever a product's tools are missing, and it
names the exact variables and Claude Desktop **Settings → Extensions** fields that are still empty.

---

## 1. Claude Desktop (chat, and on-device Cowork)

Install the bundle for each product you use. One bundle per product, each asking only for that
product's credentials:

```bash
npm ci
npm run mcpb:pack
# dist/connectwise-psa.mcpb
# dist/connectwise-automate.mcpb
```

Double-click the `.mcpb`, or **Settings → Extensions → Advanced settings → Install extension**.

Then, for each installed extension:

1. **Enable it.** A newly installed extension that is left disabled contributes no tools and
   shows nothing in the client — it does not report an error.
2. **Fill every field.** A partly filled product is not a partly working product: the server
   refuses a half-configured product and says which field is empty. Automate needs the URL,
   **username**, password and clientId — all four.
3. **If the login account has two-factor authentication enabled**, fill the optional **Automate TOTP
   secret** field with the base32 seed that account's authenticator was
   enrolled with; the connector then generates each passcode itself. Better still, use a dedicated
   API service account exempt from two-factor and leave the field blank. See
   [SETUP.md](./SETUP.md#troubleshooting).
4. **Restart Claude Desktop**, then ask it to run `cw_status_server`.

Where things live on macOS:

| | Path |
| --- | --- |
| Installed extensions | `~/Library/Application Support/Claude/Claude Extensions/local.mcpb.divergeit.connectwise-<product>/` |
| Extension settings (incl. your field values) | `~/Library/Application Support/Claude/Claude Extensions Settings/` |
| Logs | `~/Library/Logs/Claude/mcp-server-*.log` |

On Windows, replace `~/Library/Application Support/Claude` with `%APPDATA%\Claude`.

Writes are gated per product. Each bundle has a **write mode** switch and an **allow destructive**
switch, both off by default: write tools stay listed but refuse until write mode is on, the
disruptive tier (reboots, disruptive agent commands, deletes, uninstalls, raw `*_api_write`) also
needs allow destructive, every write call needs `confirm: true`, and Claude Code prompts a person on
every raw-write call. `cw_status_gate` reports what is on. Outside Claude Desktop the switches are
`CW_PSA_MODE=write` / `CW_PSA_ALLOW_DESTRUCTIVE=true` and `CW_AUTOMATE_MODE=write` /
`CW_AUTOMATE_ALLOW_DESTRUCTIVE=true`.

## 2. Claude Code (CLI, VS Code, JetBrains, and the desktop Code tab)

User scope (available in every project):

```bash
claude mcp add --scope user connectwise-psa \
  --env CW_PSA_SITE=na.myconnectwise.net \
  --env CW_PSA_COMPANY_ID=yourco \
  --env CW_PSA_PUBLIC_KEY=... \
  --env CW_PSA_PRIVATE_KEY=... \
  --env CW_PSA_CLIENT_ID=... \
  -- node /absolute/path/to/connectwise-mcp/dist/stdio.js
```

Automate is the same command with its own variables:

```bash
claude mcp add --scope user connectwise-automate \
  --env CW_AUTOMATE_URL=https://rmm.example.com \
  --env CW_AUTOMATE_USERNAME=... \
  --env CW_AUTOMATE_PASSWORD=... \
  --env CW_AUTOMATE_CLIENT_ID=... \
  -- node /absolute/path/to/connectwise-mcp/dist/stdio.js

```

Project scope instead — commit `.mcp.json` at the repo root (without secrets; `${VAR}` is
expanded from the environment):

```json
{
  "mcpServers": {
    "connectwise-psa": {
      "command": "node",
      "args": ["/absolute/path/to/connectwise-mcp/dist/stdio.js"],
      "env": {
        "CW_PSA_SITE": "na.myconnectwise.net",
        "CW_PSA_COMPANY_ID": "yourco",
        "CW_PSA_PUBLIC_KEY": "${CW_PSA_PUBLIC_KEY}",
        "CW_PSA_PRIVATE_KEY": "${CW_PSA_PRIVATE_KEY}",
        "CW_PSA_CLIENT_ID": "${CW_PSA_CLIENT_ID}"
      }
    }
  }
}
```

The remote endpoint instead of the local process:

```bash
claude mcp add --transport http connectwise https://<host>/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Already have it in Claude Desktop? `claude mcp add-from-claude-desktop` imports the Desktop
entries (macOS and WSL). Verify any of these with `/mcp` inside Claude Code.

## 3. claude.ai, Claude mobile, and remote Cowork

These never run a local process, so a `.mcpb` bundle cannot reach them. They need the hosted
Streamable HTTP endpoint — for ConnectWise that is the **Azure Container App** described in
[deploying-azure.md](./deploying-azure.md):

```bash
# the deployed URL
az containerapp show --name connectwise-mcp --resource-group <rg> \
  --query properties.configuration.ingress.fqdn -o tsv
# -> connectwise-mcp.<region>.azurecontainerapps.io   ->   https://<fqdn>/mcp
```

Add it at **claude.ai → Settings → Connectors → Add custom connector**:

- **Shared token:** URL `https://<fqdn>/mcp/<MCP_AUTH_TOKEN>` — the path-token form, because
  custom connectors cannot send an `Authorization` header.
- **Per-user Microsoft Entra sign-in (preferred):** URL `https://<fqdn>/mcp`. The server serves
  RFC 9728 protected-resource metadata, so the client discovers Entra and each person signs in as
  themselves. Setup — app registration, the `access_as_user` scope, the
  `https://claude.ai/api/mcp/auth_callback` redirect URI — is in
  [ENTRA_SETUP.md](./ENTRA_SETUP.md).

The remote entry **refuses to start** with neither `MCP_AUTH_TOKEN` nor the Entra pair set. That
is deliberate: this connector writes.

## 4. ChatGPT desktop and Codex

**Codex CLI / IDE** — `~/.codex/config.toml`:

```toml
[mcp_servers.connectwise_psa]
command = "node"
args = ["/absolute/path/to/connectwise-mcp/dist/stdio.js"]
env = { CW_PSA_SITE = "na.myconnectwise.net", CW_PSA_COMPANY_ID = "yourco", CW_PSA_PUBLIC_KEY = "...", CW_PSA_PRIVATE_KEY = "...", CW_PSA_CLIENT_ID = "..." }
```

or the equivalent one-liner:

```bash
codex mcp add connectwise-psa \
  --env CW_PSA_SITE=na.myconnectwise.net --env CW_PSA_COMPANY_ID=yourco \
  --env CW_PSA_PUBLIC_KEY=... --env CW_PSA_PRIVATE_KEY=... --env CW_PSA_CLIENT_ID=... \
  -- node /absolute/path/to/connectwise-mcp/dist/stdio.js
```

**ChatGPT desktop app** — Settings → **MCP servers → Add server → STDIO**, command `node`,
argument the absolute `dist/stdio.js` path, plus the same environment variables.

**ChatGPT on the web** takes remote MCP only: use the same hosted URL as claude.ai (section 3),
added as a connector in developer mode.

Every interactive tool carries `_meta["openai/outputTemplate"]` alongside the MCP Apps key, so
`cw_get_ticket`, `cw_view_board`, `cw_view_company`, `cw_view_time`, `cw_view_project`,
`cw_view_schedule` and the `cw_automate_view_*` views render as widgets where the Apps SDK
is enabled, and return the same JSON where it is not.

## 5. Cursor, Windsurf, VS Code Copilot

Cursor (`~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` in one) and Windsurf
(`~/.codeium/windsurf/mcp_config.json`) use the `mcpServers` shape:

```json
{
  "mcpServers": {
    "connectwise-psa": {
      "command": "node",
      "args": ["/absolute/path/to/connectwise-mcp/dist/stdio.js"],
      "env": { "CW_PSA_SITE": "na.myconnectwise.net", "CW_PSA_COMPANY_ID": "yourco", "CW_PSA_PUBLIC_KEY": "...", "CW_PSA_PRIVATE_KEY": "...", "CW_PSA_CLIENT_ID": "..." }
    }
  }
}
```

VS Code Copilot uses `.vscode/mcp.json`, which wraps the same shape in `servers` and can prompt
for secrets instead of storing them:

```json
{
  "inputs": [
    { "id": "cw-private-key", "type": "promptString", "description": "PSA private key", "password": true }
  ],
  "servers": {
    "connectwise-psa": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/connectwise-mcp/dist/stdio.js"],
      "env": {
        "CW_PSA_SITE": "na.myconnectwise.net",
        "CW_PSA_COMPANY_ID": "yourco",
        "CW_PSA_PUBLIC_KEY": "...",
        "CW_PSA_PRIVATE_KEY": "${input:cw-private-key}",
        "CW_PSA_CLIENT_ID": "..."
      }
    }
  }
}
```

## 6. Verify

In any client, in this order:

1. `cw_status_server` — which products are configured, how many tools are registered, and the
   exact variables and Settings fields any unconfigured product is still missing. This works even
   when nothing at all is configured.
2. `cw_status_system` — reaches PSA and returns its version: the cheap credentials check.
3. `cw_automate_test_connection` — the same proof for Automate, plus whether the login is an
   integrator account.
4. `cw_view_board` with a board name — proves the interactive surface renders (and falls back to
   JSON on a host without MCP Apps).

If a product's tools are absent, the answer is almost always one of two things: the extension is
disabled, or one of its fields is empty. `cw_status_server` distinguishes them.
