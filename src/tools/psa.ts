import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PsaClient, buildPatchOps, type ListParams } from "../lib/psa-client.js";
import { jsonResult, errorResult } from "../lib/format.js";
import { registerSpecTool, type ToolSpec } from "./spec.js";
import { registerTicketCard, TICKET_VIEW_SPEC } from "../apps/index.js";

const pageShape = {
  page: z.number().int().min(1).optional().describe("Page number (default 1)"),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Results per page (default 25, max 1000)"),
};

function listShape(conditionHint: string) {
  return {
    conditions: z
      .string()
      .optional()
      .describe(`Filter expression, e.g. ${conditionHint} — see server instructions for syntax`),
    orderBy: z.string().optional().describe('Sort field and direction, e.g. "id desc"'),
    fields: z
      .string()
      .optional()
      .describe('Comma-separated fields to return; "all" for full records. Defaults to a compact set.'),
    ...pageShape,
  };
}

/** fields: omitted -> compact default, "all" -> full record, anything else -> caller's list */
function resolveFields(input: string | undefined, fallback?: string): string | undefined {
  if (input === "all") return undefined;
  return input || fallback;
}

type SearchArgs = ListParams & { childConditions?: string; customFieldConditions?: string };

interface SearchSpec extends ToolSpec {
  path: string;
  description: string;
  conditionHint: string;
  defaultFields: string;
  childConditionsHint?: string;
  customFieldConditions?: boolean;
}

const SEARCHES: SearchSpec[] = [
  {
    name: "cw_search_tickets",
    summary: "Search service tickets",
    surface: "psa",
    kind: "read",
    path: "/service/tickets",
    description: "Search PSA service tickets (helpdesk). Returns a compact summary per ticket.",
    conditionHint:
      'status/name="New" and board/name="Help Desk", summary contains "vpn", company/identifier="acme", owner/identifier="pking", closedFlag=false, lastUpdated > [2026-06-01T00:00:00Z]',
    defaultFields:
      "id,summary,recordType,board/name,status/name,priority/name,company/identifier,contact/name,owner/identifier,closedFlag",
    customFieldConditions: true,
  },
  {
    name: "cw_search_companies",
    summary: "Search companies (clients and vendors)",
    surface: "psa",
    kind: "read",
    path: "/company/companies",
    description: "Search PSA companies (clients/vendors).",
    conditionHint: 'name like "acme%", identifier="acme", status/name="Active"',
    defaultFields: "id,identifier,name,status/name,phoneNumber,city,state,website",
    childConditionsHint: 'Filter on child arrays, e.g. types/name="Managed"',
    customFieldConditions: true,
  },
  {
    name: "cw_search_contacts",
    summary: "Search contacts",
    surface: "psa",
    kind: "read",
    path: "/company/contacts",
    description: "Search PSA contacts. Email lives in communicationItems — search it via childConditions.",
    conditionHint: 'firstName like "Pat%" and company/identifier="acme", inactiveFlag=false',
    defaultFields: "id,firstName,lastName,title,company/identifier,defaultPhoneNbr,inactiveFlag",
    childConditionsHint:
      'e.g. communicationItems/value like "john@acme.com" AND communicationItems/communicationType="Email"',
    customFieldConditions: true,
  },
  {
    name: "cw_search_configurations",
    summary: "Search configurations — the managed assets tracked per company",
    surface: "psa",
    kind: "read",
    path: "/company/configurations",
    description: "Search PSA configurations — managed devices/assets tracked per company.",
    conditionHint:
      'company/identifier="acme" and activeFlag=true, type/name="Managed Workstation", serialNumber="ABC123", name contains "SRV"',
    defaultFields:
      "id,name,type/name,status/name,company/identifier,serialNumber,tagNumber,ipAddress,osType,lastLoginName,activeFlag",
    customFieldConditions: true,
  },
  {
    name: "cw_search_time_entries",
    summary: "Search time entries",
    surface: "psa",
    kind: "read",
    path: "/time/entries",
    description: "Search PSA time entries.",
    conditionHint:
      'member/identifier="pking" and timeStart > [2026-06-01T00:00:00Z], chargeToId=12345 and chargeToType="ServiceTicket"',
    defaultFields:
      "id,company/identifier,member/identifier,chargeToType,chargeToId,timeStart,timeEnd,actualHours,billableOption,notes",
  },
  {
    name: "cw_search_projects",
    summary: "Search projects",
    surface: "psa",
    kind: "read",
    path: "/project/projects",
    description: "Search PSA projects.",
    conditionHint: 'company/identifier="acme" and closedFlag=false, status/name="Open"',
    defaultFields:
      "id,name,company/identifier,status/name,board/name,manager/identifier,estimatedEnd,actualHours,budgetHours,closedFlag",
  },
  {
    name: "cw_search_project_tickets",
    summary: "Search project tickets — work items inside projects",
    surface: "psa",
    kind: "read",
    path: "/project/tickets",
    description: "Search project tickets (work items inside projects — separate from service tickets).",
    conditionHint: 'project/id=123, phase/name contains "Deploy", closedFlag=false, wbsCode="1.2"',
    defaultFields:
      "id,summary,wbsCode,project/name,phase/name,status/name,company/identifier,owner/identifier,closedFlag",
  },
  {
    name: "cw_search_purchase_orders",
    summary: "Search procurement purchase orders",
    surface: "psa",
    kind: "read",
    path: "/procurement/purchaseorders",
    description: "Search procurement purchase orders.",
    conditionHint: 'vendorCompany/identifier="ingram", closedFlag=false, poNumber="PO-1234"',
    defaultFields: "id,poNumber,status/name,vendorCompany/identifier,shipmentDate,total,closedFlag",
  },
  {
    name: "cw_search_expenses",
    summary: "Search expense entries",
    surface: "psa",
    kind: "read",
    path: "/expense/entries",
    description:
      "Search PSA expense entries (reimbursable/billable expenses logged against tickets, projects, or charge codes).",
    conditionHint:
      'member/identifier="pking" and date > [2026-06-01T00:00:00Z], chargeToType="ServiceTicket" and chargeToId=1234, billableOption="Billable"',
    defaultFields:
      "id,type/name,company/identifier,member/identifier,chargeToType,chargeToId,amount,billableOption,date,notes,classification/name",
  },
  {
    name: "cw_search_opportunities",
    summary: "Search sales opportunities",
    surface: "psa",
    kind: "read",
    path: "/sales/opportunities",
    description: "Search PSA sales opportunities.",
    conditionHint: 'company/identifier="acme", stage/name="Qualification", expectedCloseDate < [2026-09-30T00:00:00Z]',
    defaultFields:
      "id,name,company/identifier,contact/name,stage/name,status/name,expectedCloseDate,primarySalesRep/identifier",
  },
  {
    name: "cw_search_agreements",
    summary: "Search agreements — the managed service contracts",
    surface: "psa",
    kind: "read",
    path: "/finance/agreements",
    description: "Search PSA agreements (managed service contracts).",
    conditionHint: 'company/identifier="acme" and agreementStatus="Active", type/name contains "Managed"',
    defaultFields: "id,name,type/name,company/identifier,agreementStatus,startDate,endDate",
  },
  {
    name: "cw_search_invoices",
    summary: "Search invoices",
    surface: "psa",
    kind: "read",
    path: "/finance/invoices",
    description: "Search PSA invoices.",
    conditionHint: 'company/identifier="acme" and balance > 0, date > [2026-01-01T00:00:00Z]',
    defaultFields: "id,invoiceNumber,type,company/identifier,status/name,date,dueDate,total,balance",
  },
  {
    name: "cw_search_members",
    summary: "Search members — the internal users and technicians",
    surface: "psa",
    kind: "read",
    path: "/system/members",
    description: "Search PSA members — internal users/technicians.",
    conditionHint: 'inactiveFlag=false, identifier="pking", lastName like "King%"',
    defaultFields: "id,identifier,firstName,lastName,primaryEmail,title,inactiveFlag",
  },
  {
    name: "cw_search_activities",
    summary: "Search sales activities — calls, meetings and tasks",
    surface: "psa",
    kind: "read",
    path: "/sales/activities",
    description: "Search PSA sales activities (calls, meetings, tasks).",
    conditionHint: 'assignTo/identifier="pking" and status/name="Open", company/identifier="acme"',
    defaultFields:
      "id,name,type/name,status/name,company/identifier,contact/name,assignTo/identifier,dateStart,dateEnd",
  },
  {
    name: "cw_search_schedule_entries",
    summary: "Search schedule entries — the dispatch calendar",
    surface: "psa",
    kind: "read",
    path: "/schedule/entries",
    description:
      "Search PSA schedule entries (dispatch calendar). objectId is the scheduled ticket/activity id.",
    conditionHint: 'member/identifier="pking" and dateStart > [2026-06-10T00:00:00Z], doneFlag=false',
    defaultFields: "id,name,objectId,type/name,member/identifier,dateStart,dateEnd,doneFlag,status/name",
  },
];

/** Tools that are not one of the spec-driven searches. Order matches registration order. */
const WORKFLOW_SPECS = {
  systemStatus: {
    name: "cw_status_system",
    title: "PSA System Status",
    summary: "Read instance version and cloud/on-prem status — the cheap credentials check",
    surface: "psa",
    kind: "read",
  },
  getTicketNotes: {
    name: "cw_get_ticket_notes",
    summary: "Page through every note on a ticket",
    surface: "psa",
    kind: "read",
  },
  createTicket: {
    name: "cw_create_ticket",
    summary: "Create a service ticket",
    surface: "psa",
    kind: "write",
  },
  updateTicket: {
    name: "cw_update_ticket",
    summary: "Update fields on a service ticket",
    surface: "psa",
    kind: "write",
    destructive: true,
    idempotent: true,
  },
  addTicketNote: {
    name: "cw_add_ticket_note",
    summary: "Add a discussion, internal or resolution note to a ticket",
    surface: "psa",
    kind: "write",
    // The ticket card posts internal notes through this tool.
    appAccessible: true,
  },
  getCompany: {
    name: "cw_get_company",
    summary: "Get one company by id or identifier",
    surface: "psa",
    kind: "read",
  },
  createTimeEntry: {
    name: "cw_create_time_entry",
    summary: "Log time against a ticket, project ticket, activity or charge code",
    surface: "psa",
    kind: "write",
  },
  createExpense: {
    name: "cw_create_expense",
    summary: "Log an expense against a ticket, project ticket, activity or charge code",
    surface: "psa",
    kind: "write",
  },
  listBoards: {
    name: "cw_list_boards",
    summary: "List service boards",
    surface: "psa",
    kind: "read",
  },
  getBoardInfo: {
    name: "cw_get_board_info",
    summary: "List the statuses, types and subtypes valid on one board",
    surface: "psa",
    kind: "read",
  },
  getAgreementAdditions: {
    name: "cw_get_agreement_additions",
    summary: "List the billed line items on one agreement",
    surface: "psa",
    kind: "read",
  },
  getTicketTasks: {
    name: "cw_get_ticket_tasks",
    summary: "List the checklist tasks on a ticket",
    surface: "psa",
    kind: "read",
  },
  apiGet: {
    name: "cw_api_get",
    title: "PSA API Get",
    summary: "GET any PSA endpoint that has no dedicated tool",
    surface: "psa",
    kind: "read",
  },
  apiWrite: {
    name: "cw_api_write",
    title: "PSA API Write",
    summary: "POST, PUT, PATCH or DELETE any PSA endpoint, guarded and confirmed on every call",
    surface: "psa",
    kind: "write",
    destructive: true,
    requiresUserInteraction: true,
  },
} satisfies Record<string, ToolSpec>;

/** Registration order: the searches, then the workflow tools with the ticket card where it has always been. */
export const PSA_TOOL_SPECS: ToolSpec[] = [
  ...SEARCHES,
  WORKFLOW_SPECS.systemStatus,
  TICKET_VIEW_SPEC,
  ...Object.values(WORKFLOW_SPECS).filter((spec) => spec !== WORKFLOW_SPECS.systemStatus),
];

function registerSearchTools(server: McpServer, client: PsaClient): void {
  for (const spec of SEARCHES) {
    const shape: Record<string, z.ZodTypeAny> = listShape(spec.conditionHint);
    if (spec.childConditionsHint) {
      shape.childConditions = z.string().optional().describe(spec.childConditionsHint);
    }
    if (spec.customFieldConditions) {
      shape.customFieldConditions = z
        .string()
        .optional()
        .describe('Filter on custom fields, e.g. caption="VIP" AND value=true');
    }
    registerSpecTool<SearchArgs>(
      server,
      spec,
      { description: spec.description, inputSchema: shape },
      async (args) => {
        const result = await client.getList(spec.path, {
          ...args,
          fields: resolveFields(args.fields, spec.defaultFields),
        });
        return jsonResult({
          count: result.items.length,
          page: result.page,
          hasMore: result.hasMore,
          items: result.items,
        });
      },
    );
  }
}

function escapeCondition(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function registerPsaTools(server: McpServer, client: PsaClient): void {
  registerSearchTools(server, client);

  registerSpecTool(
    server,
    WORKFLOW_SPECS.systemStatus,
    {
      description:
        "Get ConnectWise PSA instance info (version, cloud/on-prem). Cheap connectivity and credentials check.",
    },
    async () => jsonResult(await client.get("/system/info")),
  );

  // The ticket card: cw_get_ticket, an interactive read tool rendered by the apps shell.
  registerTicketCard(server, client);

  registerSpecTool<{ ticketId: number; page?: number; pageSize?: number }>(
    server,
    WORKFLOW_SPECS.getTicketNotes,
    {
      description:
        "Page through all notes on a ticket (discussion, internal analysis, resolution, and time-entry notes).",
      inputSchema: { ticketId: z.number().int(), ...pageShape },
    },
    async ({ ticketId, page, pageSize }) => {
      const notes = await client.getList(`/service/tickets/${ticketId}/allNotes`, { page, pageSize });
      return jsonResult({
        count: notes.items.length,
        page: notes.page,
        hasMore: notes.hasMore,
        items: notes.items,
      });
    },
  );

  registerSpecTool<{
    summary: string;
    companyIdentifier?: string;
    companyId?: number;
    board?: string;
    status?: string;
    priority?: string;
    type?: string;
    subType?: string;
    item?: string;
    contactId?: number;
    ownerIdentifier?: string;
    initialDescription?: string;
    severity?: string;
    impact?: string;
  }>(
    server,
    WORKFLOW_SPECS.createTicket,
    {
      description:
        "Create a service ticket. Company is required (identifier or id). Board/status/priority default from company settings when omitted; use cw_list_boards + cw_get_board_info for valid names.",
      inputSchema: {
        summary: z.string().min(1).max(100).describe("Ticket summary (max 100 chars)"),
        companyIdentifier: z
          .string()
          .optional()
          .describe('Company identifier, e.g. "acme" (this or companyId required)'),
        companyId: z.number().int().optional().describe("Company record id"),
        board: z.string().optional().describe('Board name, e.g. "Help Desk"'),
        status: z.string().optional().describe("Status name valid for the board"),
        priority: z.string().optional().describe('Priority name, e.g. "Priority 3 - Medium"'),
        type: z.string().optional().describe("Ticket type name (board-specific)"),
        subType: z.string().optional(),
        item: z.string().optional(),
        contactId: z.number().int().optional().describe("Contact record id"),
        ownerIdentifier: z.string().optional().describe("Member identifier to assign as owner"),
        initialDescription: z.string().optional().describe("Body of the first (discussion) note"),
        severity: z.enum(["Low", "Medium", "High"]).optional(),
        impact: z.enum(["Low", "Medium", "High"]).optional(),
      },
    },
    async (args) => {
      if (!args.companyIdentifier && args.companyId === undefined) {
        return errorResult(new Error("Provide companyIdentifier or companyId"));
      }
      const body = {
        summary: args.summary,
        company:
          args.companyId !== undefined ? { id: args.companyId } : { identifier: args.companyIdentifier },
        board: args.board ? { name: args.board } : undefined,
        status: args.status ? { name: args.status } : undefined,
        priority: args.priority ? { name: args.priority } : undefined,
        type: args.type ? { name: args.type } : undefined,
        subType: args.subType ? { name: args.subType } : undefined,
        item: args.item ? { name: args.item } : undefined,
        contact: args.contactId !== undefined ? { id: args.contactId } : undefined,
        owner: args.ownerIdentifier ? { identifier: args.ownerIdentifier } : undefined,
        initialDescription: args.initialDescription,
        severity: args.severity,
        impact: args.impact,
      };
      return jsonResult(await client.post("/service/tickets", body));
    },
  );

  registerSpecTool<{ id: number; updates: Record<string, unknown> }>(
    server,
    WORKFLOW_SPECS.updateTicket,
    {
      description:
        'Update fields on a service ticket via PATCH. `updates` maps field path -> new value; reference fields take whole objects, e.g. {"status":{"name":"In Progress"},"owner":{"identifier":"pking"},"priority":{"name":"Priority 2"},"summary":"New summary"}. A null value clears the field. customFields must be passed as the complete array.',
      inputSchema: {
        id: z.number().int().describe("Ticket id"),
        updates: z.record(z.unknown()).describe("Field path -> new value map"),
      },
    },
    async ({ id, updates }) => {
      if (Object.keys(updates).length === 0) return errorResult(new Error("updates is empty"));
      return jsonResult(await client.patch(`/service/tickets/${id}`, buildPatchOps(updates)));
    },
  );

  registerSpecTool<{
    ticketId: number;
    text: string;
    noteType?: "discussion" | "internal" | "resolution";
    internal?: boolean;
  }>(
    server,
    WORKFLOW_SPECS.addTicketNote,
    {
      description: "Add a note to a service ticket.",
      inputSchema: {
        ticketId: z.number().int(),
        text: z.string().min(1),
        noteType: z
          .enum(["discussion", "internal", "resolution"])
          .optional()
          .describe("Which ticket section the note lands in (default discussion)"),
        internal: z.boolean().optional().describe("Hide from the customer portal (default false)"),
      },
    },
    async ({ ticketId, text, noteType, internal }) => {
      const kind = noteType ?? "discussion";
      const body = {
        text,
        detailDescriptionFlag: kind === "discussion",
        internalAnalysisFlag: kind === "internal",
        resolutionFlag: kind === "resolution",
        internalFlag: internal ?? false,
      };
      return jsonResult(await client.post(`/service/tickets/${ticketId}/notes`, body));
    },
  );

  registerSpecTool<{ company: number | string }>(
    server,
    WORKFLOW_SPECS.getCompany,
    {
      description: "Get one company with full detail, by record id (number) or identifier (string).",
      inputSchema: {
        company: z
          .union([z.number().int(), z.string()])
          .describe('Company id (number) or identifier (string), e.g. 250 or "acme"'),
      },
    },
    async ({ company }) => {
      if (typeof company === "number") {
        return jsonResult(await client.get(`/company/companies/${company}`));
      }
      const result = await client.getList("/company/companies", {
        conditions: `identifier="${escapeCondition(company)}"`,
        pageSize: 1,
      });
      if (result.items.length === 0) {
        return errorResult(new Error(`Company not found: ${company}`));
      }
      return jsonResult(result.items[0]);
    },
  );

  registerSpecTool<{
    chargeToType: string;
    chargeToId: number;
    timeStart: string;
    timeEnd?: string;
    notes?: string;
    internalNotes?: string;
    billableOption?: string;
    memberIdentifier?: string;
    workRole?: string;
  }>(
    server,
    WORKFLOW_SPECS.createTimeEntry,
    {
      description: "Log time against a ticket, project ticket, activity, or charge code.",
      inputSchema: {
        chargeToType: z.enum(["ServiceTicket", "ProjectTicket", "ChargeCode", "Activity"]),
        chargeToId: z.number().int().describe("Id of the ticket/activity/charge code"),
        timeStart: z.string().describe("UTC ISO-8601 start, e.g. 2026-06-10T17:00:00Z"),
        timeEnd: z.string().optional().describe("UTC ISO-8601 end"),
        notes: z.string().optional().describe("Work performed (customer-visible per billing setup)"),
        internalNotes: z.string().optional(),
        billableOption: z.enum(["Billable", "DoNotBill", "NoCharge", "NoDefault"]).optional(),
        memberIdentifier: z
          .string()
          .optional()
          .describe("Member to log time for (defaults to the API member)"),
        workRole: z.string().optional().describe("Work role name"),
      },
    },
    async (args) => {
      const body = {
        chargeToType: args.chargeToType,
        chargeToId: args.chargeToId,
        timeStart: args.timeStart,
        timeEnd: args.timeEnd,
        notes: args.notes,
        internalNotes: args.internalNotes,
        billableOption: args.billableOption,
        member: args.memberIdentifier ? { identifier: args.memberIdentifier } : undefined,
        workRole: args.workRole ? { name: args.workRole } : undefined,
      };
      return jsonResult(await client.post("/time/entries", body));
    },
  );

  registerSpecTool<{
    expenseType: string;
    amount: number;
    date: string;
    chargeToType?: string;
    chargeToId?: number;
    companyIdentifier?: string;
    billableOption?: string;
    notes?: string;
    classification?: string;
    paymentMethod?: string;
    memberIdentifier?: string;
  }>(
    server,
    WORKFLOW_SPECS.createExpense,
    {
      description:
        "Log an expense against a ticket, project ticket, activity, or charge code. type, amount, and date are required.",
      inputSchema: {
        expenseType: z.string().describe('Expense type name, e.g. "Mileage", "Meals", "Airfare"'),
        amount: z.number().describe("Expense amount"),
        date: z.string().describe("Date of expense, ISO-8601 e.g. 2026-06-10T00:00:00Z"),
        chargeToType: z.enum(["ServiceTicket", "ProjectTicket", "ChargeCode", "Activity"]).optional(),
        chargeToId: z.number().int().optional().describe("Id of the ticket/activity/charge code"),
        companyIdentifier: z
          .string()
          .optional()
          .describe("Company identifier (derives from charge target if omitted)"),
        billableOption: z.enum(["Billable", "DoNotBill", "NoCharge", "NoDefault"]).optional(),
        notes: z.string().optional(),
        classification: z
          .string()
          .optional()
          .describe("Expense classification name (e.g. Billable, Non-Billable)"),
        paymentMethod: z.string().optional().describe("Payment method name"),
        memberIdentifier: z.string().optional().describe("Member to log for (defaults to the API member)"),
      },
    },
    async (args) => {
      const body = {
        type: { name: args.expenseType },
        amount: args.amount,
        date: args.date,
        chargeToType: args.chargeToType,
        chargeToId: args.chargeToId,
        company: args.companyIdentifier ? { identifier: args.companyIdentifier } : undefined,
        billableOption: args.billableOption,
        notes: args.notes,
        classification: args.classification ? { name: args.classification } : undefined,
        paymentMethod: args.paymentMethod ? { name: args.paymentMethod } : undefined,
        member: args.memberIdentifier ? { identifier: args.memberIdentifier } : undefined,
      };
      return jsonResult(await client.post("/expense/entries", body));
    },
  );

  registerSpecTool<{ conditions?: string; page?: number; pageSize?: number }>(
    server,
    WORKFLOW_SPECS.listBoards,
    {
      description: "List service boards. Use before creating/moving tickets to find valid board names.",
      inputSchema: {
        conditions: z.string().optional().describe("e.g. inactiveFlag=false or projectFlag=false"),
        ...pageShape,
      },
    },
    async ({ conditions, page, pageSize }) => {
      const result = await client.getList("/service/boards", {
        conditions,
        page,
        pageSize: pageSize ?? 100,
        fields: "id,name,inactiveFlag,projectFlag",
      });
      return jsonResult({ count: result.items.length, hasMore: result.hasMore, items: result.items });
    },
  );

  registerSpecTool<{ boardId: number }>(
    server,
    WORKFLOW_SPECS.getBoardInfo,
    {
      description:
        "Get the valid statuses, types, and subtypes for one service board — needed to set those fields on tickets.",
      inputSchema: { boardId: z.number().int() },
    },
    async ({ boardId }) => {
      const [statuses, types, subTypes] = await Promise.all([
        client.getList(`/service/boards/${boardId}/statuses`, {
          pageSize: 200,
          fields: "id,name,sortOrder,closedStatus,defaultFlag,inactive",
        }),
        client.getList(`/service/boards/${boardId}/types`, { pageSize: 200, fields: "id,name" }),
        client.getList(`/service/boards/${boardId}/subtypes`, { pageSize: 200, fields: "id,name" }),
      ]);
      return jsonResult({ statuses: statuses.items, types: types.items, subTypes: subTypes.items });
    },
  );

  registerSpecTool<{ agreementId: number; conditions?: string; page?: number; pageSize?: number }>(
    server,
    WORKFLOW_SPECS.getAgreementAdditions,
    {
      description:
        "List the additions (billed line items: licenses, seats, products) on one agreement — what the client is actually billed for.",
      inputSchema: {
        agreementId: z.number().int(),
        conditions: z.string().optional().describe('e.g. cancelledDate=null or agreementStatus="Active"'),
        ...pageShape,
      },
    },
    async ({ agreementId, conditions, page, pageSize }) => {
      const result = await client.getList(`/finance/agreements/${agreementId}/additions`, {
        conditions,
        page,
        pageSize,
        fields:
          "id,product/identifier,description,quantity,unitPrice,unitCost,effectiveDate,cancelledDate,agreementStatus,lessIncluded",
      });
      return jsonResult({ count: result.items.length, hasMore: result.hasMore, items: result.items });
    },
  );

  registerSpecTool<{ ticketId: number; page?: number; pageSize?: number }>(
    server,
    WORKFLOW_SPECS.getTicketTasks,
    {
      description: "List the checklist tasks on a service ticket.",
      inputSchema: { ticketId: z.number().int(), ...pageShape },
    },
    async ({ ticketId, page, pageSize }) => {
      const result = await client.getList(`/service/tickets/${ticketId}/tasks`, {
        page,
        pageSize,
        fields: "id,summary,notes,closedFlag,resolution",
      });
      return jsonResult({ count: result.items.length, hasMore: result.hasMore, items: result.items });
    },
  );

  const psaPath = z
    .string()
    .regex(/^\//, "path must start with /")
    .describe('API path, e.g. "/service/priorities"');

  registerSpecTool<{ path: string; query?: Record<string, string> }>(
    server,
    WORKFLOW_SPECS.apiGet,
    {
      description:
        "Read-only escape hatch to the full ConnectWise PSA REST API (1,800+ endpoints) when no dedicated tool fits. GET only. Examples: /service/priorities; /system/departments; /sales/stages; /procurement/purchaseorders. List endpoints accept query params conditions/fields/orderBy/page/pageSize. Prefer the dedicated tools when one exists; use cw_api_write to change anything.",
      inputSchema: { path: psaPath, query: z.record(z.string()).optional().describe("Query string parameters") },
    },
    async ({ path, query }) => {
      const { data, response } = await client.request("GET", normalizePsaPath(path), { query });
      const hasMore = /rel="next"/.test(response.headers.get("link") ?? "");
      return jsonResult(
        Array.isArray(data) ? { count: data.length, hasMore, items: data } : (data ?? { status: response.status }),
      );
    },
  );

  registerSpecTool<{
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    confirm?: boolean;
  }>(
    server,
    WORKFLOW_SPECS.apiWrite,
    {
      description:
        "Write escape hatch to the ConnectWise PSA REST API for endpoints with no dedicated tool. Every call changes live PSA data, so hosts are asked to confirm each one, and DELETE additionally requires confirm: true. Use the dedicated write tools when one exists.",
      inputSchema: {
        method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
        path: psaPath,
        query: z.record(z.string()).optional().describe("Query string parameters"),
        body: z
          .unknown()
          .optional()
          .describe("JSON body for POST/PUT; array of {op,path,value} ops for PATCH"),
        confirm: z.boolean().optional().describe("Must be true for DELETE — deletions are permanent"),
      },
    },
    async ({ method, path, query, body, confirm }) => {
      if (method === "DELETE" && confirm !== true) {
        return errorResult(
          new Error("Refusing DELETE without confirm: true — PSA deletions cannot be undone"),
        );
      }
      const { data, response } = await client.request(method, normalizePsaPath(path), { query, body });
      return jsonResult(data ?? { status: response.status });
    },
  );
}

/** Callers paste full URLs from the API docs; strip the version prefix they carry. */
function normalizePsaPath(path: string): string {
  return path.replace(/^\/v4_6_release\/apis\/3\.0/, "");
}
