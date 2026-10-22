---
name: Asset Management
description: Use for ConnectWise configurations — managed devices and assets — e.g. "what servers do we manage for Acme", "find the config with serial ABC123", "list workstations at this client", "what's the warranty on their firewall", "show all assets of type X". Searches and reports on tracked configurations.
version: 0.1.0
---

# ConnectWise Asset Management

Answer "what do we manage for this client" and find specific devices fast.

## Tools

- `cw_search_configurations` — managed devices/assets (servers, workstations, network gear, etc.)
- `cw_api_get` — configuration types (`/company/configurations/types`) and anything else under `/company/configurations/*`

## Workflow

1. **Search configurations.** `cw_search_configurations`:
   - A client's active assets: `company/identifier="acme" and activeFlag=true`
   - By type: `type/name="Managed Workstation"` or `type/name="Server"`
   - By identity: `serialNumber="ABC123"`, `tagNumber="..."`, or `name contains "SRV"`
   - By address: `ipAddress="10.0.0.5"`
2. **Report.** Group by type for a footprint view; per asset surface name, type, status, serial, IP, OS, last login, and active flag. Note inactive/retired separately.
3. **Lifecycle** when asked: installation date and warranty/expiration live on the config — pull `fields: "all"` or query specific fields for warranty dates.

## Tips

- "What do we manage for them" → active configs grouped by type, with counts.
- Custom asset attributes: search with `customFieldConditions` (e.g. `caption="Warranty" AND value!=null`).
- Tie an asset to its tickets via the company + config reference when troubleshooting.

## Guardrails

Read-first. Confirm before creating/updating or retiring configurations.
