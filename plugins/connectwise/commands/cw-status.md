---
name: cw-status
description: Check ConnectWise MCP connectivity and show what's enabled
allowed-tools: ["mcp__plugin_connectwise_connectwise__psa_system_info"]
---

Verify the ConnectWise connection and report status.

1. Call `cw_status_server` — it works even when nothing is configured and reports which ConnectWise products are on and what any unconfigured one is missing.
2. Call `cw_status_system` for the PSA credentials check itself.
3. If it succeeds, report: connected ✓, the PSA version, and whether it's cloud or on-premise.
4. If it fails:
   - 401 → the `CONNECTWISE_MCP_TOKEN` is missing or wrong (check the env var the plugin reads).
   - tools missing / "no tools" → run `cw_status_server`; it names the missing variables and, for a Claude Desktop install, the Settings → Extensions fields they come from.
   - connection error → check `CONNECTWISE_MCP_URL` points at the deployed `/mcp` endpoint.

Keep it to a couple lines. This is a quick health check before doing real work.
