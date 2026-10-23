# Go-Live Checklist

The server is deployed and running on Azure. Two things are intentionally **not yet turned on**. Each is a self-contained step you can do independently, in any order. Nothing below requires a code change or redeploy.

- **Live URL:** `https://connectwise-mcp.blackfield-07c0bc4a.westus2.azurecontainerapps.io`
- **Azure:** subscription `07f11679-d297-4e64-8604-aa2aa5361013` → resource group `rg-connectwise-mcp` → app `connectwise-mcp` (westus2)
- **Endpoint token:** stored as ACA secret `mcp-auth-token`; plaintext copy in the repo-root `.env` (gitignored)

Current state: health endpoint up · shared-token auth enforced · 27 PSA tools coded but returning 0 until credentials are set · Entra validation coded but dormant.

---

## ☐ Step 1 — ConnectWise API keys (lights up the tools)

Gets you: all 27 PSA tools return real data. **Owner:** whoever has PSA admin.

1. Create an **API Member** in PSA (System → Members → API Members), scope its security role, generate public/private keys.
2. Get a **clientId** GUID from <https://developer.connectwise.com/ClientID>.
3. Set them (no rebuild — tools appear on the next request):

```bash
az containerapp secret set -n connectwise-mcp -g rg-connectwise-mcp --secrets \
  cw-psa-company-id='YOUR_COMPANY_ID' \
  cw-psa-public-key='YOUR_PUBLIC_KEY' \
  cw-psa-private-key='YOUR_PRIVATE_KEY' \
  cw-psa-client-id='YOUR_CLIENT_GUID'

az containerapp update -n connectwise-mcp -g rg-connectwise-mcp --set-env-vars \
  CW_PSA_SITE=api-na.myconnectwise.net \
  CW_PSA_COMPANY_ID=secretref:cw-psa-company-id \
  CW_PSA_PUBLIC_KEY=secretref:cw-psa-public-key \
  CW_PSA_PRIVATE_KEY=secretref:cw-psa-private-key \
  CW_PSA_CLIENT_ID=secretref:cw-psa-client-id
```

⚠️ Set **all five** `CW_PSA_*` vars together — partial config crash-loops the container by design.

**Verify:** in Claude, run `cw_status_system` → returns your PSA version. Full details: [SETUP.md](./SETUP.md).

---

## ☐ Step 2 — Per-user Entra sign-in (optional; replaces/augments the shared token)

Gets you: each tech signs in with their Microsoft account instead of sharing the URL token; MFA/Conditional Access apply; per-user revocation. **Owner:** needs **Application Administrator** or **Global Administrator** (a standard account gets `Insufficient privileges` — this was the blocker when we tried earlier).

1. Run the app-registration script in [ENTRA_SETUP.md](./ENTRA_SETUP.md) as the admin.
2. Wire the (public, non-secret) identifiers in:

```bash
az containerapp update -n connectwise-mcp -g rg-connectwise-mcp \
  --set-env-vars AZURE_TENANT_ID=<tenant-guid> AZURE_CLIENT_ID=<app-client-guid>
```

**Verify:** `curl https://<fqdn>/.well-known/oauth-protected-resource` returns JSON (not 404). Then add the connector in claude.ai with the bare `/mcp` URL + OAuth Client ID → Microsoft sign-in appears.

Tenant for this subscription: `91b3bb94-7af1-4bfb-8861-a6a23d8ad956`.

To go Entra-only afterward: `az containerapp update -n connectwise-mcp -g rg-connectwise-mcp --remove-env-vars MCP_AUTH_TOKEN`.

---

## ☐ Step 3 — Connect Claude

Until Step 2 is done, use the shared-token URL:

```
https://connectwise-mcp.blackfield-07c0bc4a.westus2.azurecontainerapps.io/mcp/<token-from-.env>
```

claude.ai → Settings → Connectors → Add custom connector → paste that URL. Client-by-client instructions: [SETUP.md §5](./SETUP.md).

---

## Rotating the shared token

```bash
NEW=$(openssl rand -hex 32)
az containerapp secret set -n connectwise-mcp -g rg-connectwise-mcp --secrets mcp-auth-token="$NEW"
az containerapp revision restart -n connectwise-mcp -g rg-connectwise-mcp \
  $(az containerapp revision list -n connectwise-mcp -g rg-connectwise-mcp --query "[?properties.active].name | [0]" -o tsv)
```

Update the connector URL/header in each client afterward.
