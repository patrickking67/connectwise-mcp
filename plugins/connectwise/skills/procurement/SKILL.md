---
name: Procurement
description: Use for ConnectWise procurement and purchasing — e.g. "what POs are open", "did the Dell order ship", "purchase orders for Acme", "what are we waiting on from Ingram". Reviews purchase orders and their line items.
version: 0.1.0
---

# ConnectWise Procurement

Track what's on order and what's still outstanding from vendors.

## Tools

- `cw_search_purchase_orders` — POs by vendor, status, company
- `cw_api_get` — PO line items (`/procurement/purchaseorders/{id}/lineitems`), products (`/procurement/products`), and the rest of `/procurement/*`

## Workflow

1. **Find POs.** `cw_search_purchase_orders`:
   - Open: `closedFlag=false`
   - By vendor: `vendorCompany/identifier="ingram"`
   - By number: `poNumber="PO-1234"`
2. **Status read.** Surface PO number, vendor, status, total, and ship date. Flag open POs past their expected `shipmentDate` — those are what to chase.
3. **Line items** when asked: `cw_api_get` on `/procurement/purchaseorders/{id}/lineitems` — what's on the order, received vs. outstanding quantities.

## Tips

- "What are we waiting on" = open POs, oldest first, with vendor and ship date.
- Tie procurement back to the client by `company/identifier` when the order is for a specific project/ticket.

## Guardrails

Read-first. Purchase orders affect inventory and vendor commitments — confirm before any change, and use `cw_api_write` (which prompts on every call and requires `confirm: true` for DELETE) only when explicitly asked.
