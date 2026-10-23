# Deploying the remote transport to Azure

The runbook for the **remote** transport. The local stdio server is not deployed
anywhere — it ships as an MCPB bundle and runs beside the MCP client on a user's
own machine. See [`SETUP.md`](SETUP.md) for that path.

Azure is the only deployment target for this product line.

## What you are deploying, and why it is not just a transport switch

The remote server exposes the same tool catalog over HTTP instead of
stdio. Two things move, and both are decisions rather than configuration:

1. **The ConnectWise credential moves off a workstation** into Key Vault, where one
   credential serves every caller. Nobody who uses the connector holds it any
   more.
2. **Authentication becomes the server's problem.** On stdio, the boundary is
   the operating system user account: if you can run the binary, you are
   authorised. Over HTTP there is no such boundary, so the server has to
   establish one itself.

That second point is sharper here than anywhere else in the fleet, because **this
connector writes**. It can create and update tickets, add notes, create time
and expense entries and run Automate scripts once its write gate is opened, and it
carries raw request escape hatches for PSA and Automate. An endpoint serving that to whoever finds the URL is not a degraded
deployment of it — so the remote entry **refuses to start with no authentication
configured**.

## What the template creates

`infra/main.bicep`, into one resource group:

| Resource | Why |
|---|---|
| Log Analytics workspace | Where container logs land |
| Container Apps environment | The compute |
| User-assigned managed identity | Pulls the image, reads the secrets |
| Container registry | Holds the image |
| Key Vault (RBAC, purge protection on) | Holds the ConnectWise credential and the MCP token |
| Container App | The server, with external ingress on `/mcp` |

Two choices in there are load-bearing:

- **A user-assigned identity, not a system-assigned one.** Container Apps cannot
  resolve a Key Vault secret reference with a system-assigned identity on the
  first deployment, because that identity does not exist until after the app has
  been created. A user-assigned identity exists first, so the first revision
  starts with its secrets already readable.
- **Secrets are version-less Key Vault references, not literal values.**
  Container Apps re-reads them, so rotating a credential in Key Vault does not
  require redeploying this template.

## Prerequisites

- An Azure subscription, and permission to create role assignments in the target
  resource group — the template grants its own identity `Key Vault Secrets User`
  and `AcrPull`, which needs `Microsoft.Authorization/roleAssignments/write`.
- Azure CLI 2.60 or newer, signed in: `az login`.
- The ConnectWise client id and secret, from your secret manager. Do not paste them
  into a file.

## First deployment

```sh
az group create --name rg-connectwise-mcp --location eastus

# A fresh token for callers to present. Keep it out of your shell history:
#   read -rs MCP_TOKEN
MCP_TOKEN=$(openssl rand -base64 48)

az deployment group create \
  --resource-group rg-connectwise-mcp \
  --template-file infra/main.bicep \
  --parameters infra/main.parameters.json \
  --parameters \
      psaPublicKey="$CW_PSA_PUBLIC_KEY" \
      psaPrivateKey="$CW_PSA_PRIVATE_KEY" \
      psaClientId="$CW_PSA_CLIENT_ID" \
      mcpAuthToken="$MCP_TOKEN"
```

The ConnectWise credentials and `mcpAuthToken` are declared
`@secure()`, so Azure keeps them out of deployment history. They are deliberately
**not** in `infra/main.parameters.json`: that file is committed, and a credential
in it would be a credential in git history.

The first deployment uses a placeholder image so the infrastructure can exist
before any image does. Push the real one next:

```sh
registry=$(az deployment group show --resource-group rg-connectwise-mcp \
  --name main --query properties.outputs.containerRegistryName.value -o tsv)

az acr build --registry "$registry" --image connectwise-mcp-server:0.2.0 --file Dockerfile .

az containerapp update \
  --name connectwise-mcp --resource-group rg-connectwise-mcp \
  --image "$(az acr show --name "$registry" --query loginServer -o tsv)/connectwise-mcp-server:0.2.0"
```

Confirm it is serving:

```sh
curl -sS "https://$(az containerapp show --name connectwise-mcp \
  --resource-group rg-connectwise-mcp \
  --query properties.configuration.ingress.fqdn -o tsv)/healthz"
```

`/healthz` is unauthenticated and reports only that the process can answer. It
deliberately does not check ConnectWise: a vendor outage must not be reported as this
container being unhealthy, or a rollout will chase it.

## Continuous deployment

`.github/workflows/deploy-azure.yml` does the build-and-roll above on a `v*` tag
or on demand, and then polls `/healthz` until the new revision answers — a
deployment that reports success without the endpoint answering is worse than a
failed one, because nobody goes looking.

It is **off** until the repository variable `AZURE_DEPLOY_ENABLED` is `true`, and
it authenticates by OIDC federation, so there is no client secret in this
repository to leak or rotate.

Set these repository variables (Settings → Secrets and variables → Actions →
Variables):

| Variable | Value |
|---|---|
| `AZURE_DEPLOY_ENABLED` | `true` |
| `AZURE_CLIENT_ID` | App registration used for federation |
| `AZURE_TENANT_ID` | Directory (tenant) id |
| `AZURE_SUBSCRIPTION_ID` | Target subscription |
| `AZURE_RESOURCE_GROUP` | `rg-connectwise-mcp` |
| `AZURE_CONTAINER_APP` | `connectwise-mcp` |
| `AZURE_CONTAINER_REGISTRY` | Registry name from the template output |

The app registration needs a federated credential for this repository, and
`AcrPush` plus `Contributor` on the resource group:

```sh
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<owner>/<repo>:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

A tag-triggered deployment needs a second federated credential with subject
`repo:<owner>/<repo>:ref:refs/tags/*`. Federated subjects are exact matches, so a
credential for `main` will not authorise a tag push, and the failure looks like a
permissions problem rather than a missing credential.

## Authenticating callers

Two mechanisms, and they coexist.

**Shared bearer token** — simple, and the only thing some clients can present:

```http
POST /mcp
Authorization: Bearer <MCP_AUTH_TOKEN>
```

There is also a path-token route, `POST /mcp/<token>`, for clients that cannot
attach a header — claude.ai custom connectors are the concrete case. It is
strictly worse, because URLs turn up in proxy logs, so it exists but is not
recommended.

Either way, the token authenticates *the deployment*, not a person. Anyone
holding it is indistinguishable from anyone else holding it.

**Microsoft Entra ID** — per-user, and the right answer for client MSP data,
because the audit trail names a person. Set `AZURE_TENANT_ID` and
`AZURE_CLIENT_ID` (both, or neither — half-configured is rejected rather than
quietly ignored) and the server validates Entra v2 access tokens against the
tenant's published keys, checking signature, issuer, audience and expiry.

It also serves RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource`, so an OAuth-capable MCP client discovers
the authorization server on its own rather than needing manual setup.

Create an app registration, expose an API scope named `access_as_user`, and use
its application id as `AZURE_CLIENT_ID`. Both `api://<client-id>` and the bare
client id are accepted as the audience, because both are legitimate depending on
how the client requested the token.

## Rotating a credential

Rotation is a Key Vault operation, not a redeployment:

```sh
az keyvault secret set --vault-name "$VAULT" --name psa-private-key --value "$NEW"
az containerapp revision restart --name connectwise-mcp --resource-group rg-connectwise-mcp \
  --revision "$(az containerapp revision list --name connectwise-mcp \
      --resource-group rg-connectwise-mcp --query '[0].name' -o tsv)"
```

Order matters: issue the new credential, set the secret, restart, **verify**,
then revoke the old one. Revoking first turns a rotation into an outage.

## Cost, and the one knob worth knowing

`minReplicas` defaults to `1`. That keeps a warm instance so the first tool call
of the day is not a cold start, and it is the difference between a connector that
feels instant and one that feels broken the first time each morning.

Setting it to `0` costs nothing while idle and adds a few seconds to that first
call. For an internal connector used in bursts, that trade is often right — it is
a parameter for exactly that reason.

## Deploying without Automate

Leave `automateUrl` empty. Automate registers its tools only when its
credentials are configured, so an unconfigured integration contributes no
tools rather than tools that fail — that is the supported way to run PSA-only, not
something to work around.

The template still creates `automate-password` and `automate-client-id` in Key
Vault, holding the literal value `unset`. That is deliberate: Container Apps
resolves **every** declared secret when a revision starts, so a reference to a
vault entry that does not exist fails the whole revision. Creating them unused is
cheaper than making the template branch, and populating them later is a vault
write plus a restart.

## Related

- [`SETUP.md`](SETUP.md) — local install and client configuration
- [`ENTRA_SETUP.md`](ENTRA_SETUP.md) — the Entra app registration in detail
- [`GO-LIVE.md`](GO-LIVE.md) — the pre-production checklist
