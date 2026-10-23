export interface PsaConfig {
  site: string;
  companyId: string;
  publicKey: string;
  privateKey: string;
  clientId: string;
  version?: string;
}

export interface AutomateConfig {
  baseUrl: string;
  username: string;
  password: string;
  clientId: string;
  /** Optional TOTP seed, for an account that keeps two-factor enabled. */
  totpSecret?: string;
}

export interface EntraConfig {
  tenantId: string;
  clientId: string;
}

/** The products whose write tools sit behind the write gate. */
export type GateProduct = "psa" | "automate";

/**
 * The operator's standing decision about writes, per product. Both default to
 * false: a server starts read-only and the disruptive tier needs a second,
 * separate switch. See src/tools/gate.ts.
 */
export interface WriteGate {
  /** <PREFIX>_MODE=write (or true): write tools may run. */
  write: boolean;
  /** <PREFIX>_ALLOW_DESTRUCTIVE=true: the disruptive tier may run too. */
  destructive: boolean;
}

export interface AppConfig {
  port: number;
  authToken?: string;
  entra?: EntraConfig;
  psa?: PsaConfig;
  automate?: AutomateConfig;
  /** Write gate per product. Missing means read mode — fail closed. */
  gates?: Partial<Record<GateProduct, WriteGate>>;
}

/** The env var prefix each product's gate variables carry. */
export const GATE_PREFIX: Record<GateProduct, string> = {
  psa: "CW_PSA",
  automate: "CW_AUTOMATE",
};

/** Read one product's gate from the environment. */
export function gateFromEnv(rawEnv: NodeJS.ProcessEnv, product: GateProduct): WriteGate {
  const env = withoutPlaceholders(rawEnv);
  const prefix = GATE_PREFIX[product];
  const mode = (env[`${prefix}_MODE`] ?? "").trim().toLowerCase();
  const destructive = (env[`${prefix}_ALLOW_DESTRUCTIVE`] ?? "").trim().toLowerCase();
  return { write: mode === "write" || mode === "true", destructive: destructive === "true" };
}

/**
 * ConnectWise cloud instances must be called through the api- host
 * (e.g. api-na.myconnectwise.net); the bare host rejects API traffic.
 * On-premise hostnames pass through untouched.
 */
export function normalizePsaSite(input: string): string {
  let host = input.trim().replace(/^https?:\/\//i, "");
  host = host.replace(/\/.*$/, "");
  const cloud = host.match(/^([a-z]+)\.(myconnectwise\.net|connectwisedev\.com)$/i);
  if (cloud && !/^api-/i.test(cloud[1])) {
    return `api-${cloud[1].toLowerCase()}.${cloud[2].toLowerCase()}`;
  }
  return host.toLowerCase();
}

/**
 * MCP hosts pass optional user_config fields the user left blank through as the
 * literal string "${user_config.whatever}". Treat any such template as unset so
 * it never becomes a credential, a URL or a version pin.
 */
function withoutPlaceholders(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !value.includes("${")) clean[key] = value;
  }
  return clean;
}

/**
 * The environment variables each product needs, with the title of the matching
 * field in Claude Desktop's Settings > Extensions form. A diagnostic that names
 * only the variable sends a Desktop user to a form that never shows it.
 */
export interface ProductVariable {
  env: string;
  field: string;
}

export type ProductKey = "psa" | "automate";

export const PRODUCT_LABEL: Record<ProductKey, string> = {
  psa: "ConnectWise PSA (Manage)",
  automate: "ConnectWise Automate",
};

/**
 * The REQUIRED variables per product. The optional two-factor seed
 * (CW_AUTOMATE_TOTP_SECRET) and the write-gate switches (CW_*_MODE,
 * CW_*_ALLOW_DESTRUCTIVE) are deliberately not here: a product without them is
 * configured, just read-only or unable to pass a 2FA prompt.
 */
export const PRODUCT_VARIABLES: Record<ProductKey, ProductVariable[]> = {
  psa: [
    { env: "CW_PSA_SITE", field: "PSA site" },
    { env: "CW_PSA_COMPANY_ID", field: "PSA company id" },
    { env: "CW_PSA_PUBLIC_KEY", field: "PSA public key" },
    { env: "CW_PSA_PRIVATE_KEY", field: "PSA private key" },
    { env: "CW_PSA_CLIENT_ID", field: "ConnectWise clientId" },
  ],
  automate: [
    { env: "CW_AUTOMATE_URL", field: "Automate URL" },
    { env: "CW_AUTOMATE_USERNAME", field: "Automate username" },
    { env: "CW_AUTOMATE_PASSWORD", field: "Automate password" },
    { env: "CW_AUTOMATE_CLIENT_ID", field: "Automate clientId" },
  ],
};

/** `CW_AUTOMATE_USERNAME (Settings > Extensions field "Automate username")`. */
export function describeVariable(variable: ProductVariable): string {
  return `${variable.env} (Settings > Extensions field "${variable.field}")`;
}

/**
 * Which of a product's variables are set and which are missing. A product with
 * nothing set is simply not configured; one with some set is misconfigured, and
 * the message says exactly what is missing so the fix is one form field away.
 */
export function productStatus(
  env: NodeJS.ProcessEnv,
  product: ProductKey,
): { set: string[]; missing: ProductVariable[] } {
  const clean = withoutPlaceholders(env);
  const set: string[] = [];
  const missing: ProductVariable[] = [];
  for (const variable of PRODUCT_VARIABLES[product]) {
    if (clean[variable.env]?.trim()) set.push(variable.env);
    else missing.push(variable);
  }
  return { set, missing };
}

/** The error a partially configured product raises. */
export function incompleteConfigMessage(product: ProductKey, missing: ProductVariable[]): string {
  return (
    `Incomplete ${PRODUCT_LABEL[product]} configuration; missing: ` +
    `${missing.map(describeVariable).join(", ")}. ` +
    `Set every ${PRODUCT_LABEL[product]} variable, or none of them.`
  );
}

/** Values for a fully configured product, or undefined when none of its variables are set. */
function productValues(env: NodeJS.ProcessEnv, product: ProductKey): Record<string, string> | undefined {
  const { set, missing } = productStatus(env, product);
  if (set.length === 0) return undefined;
  if (missing.length > 0) throw new Error(incompleteConfigMessage(product, missing));
  const values: Record<string, string> = {};
  for (const variable of PRODUCT_VARIABLES[product]) values[variable.env] = env[variable.env]!.trim();
  return values;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = withoutPlaceholders(rawEnv);
  const config: AppConfig = {
    port: Number(env.PORT) || 8080,
    authToken: env.MCP_AUTH_TOKEN?.trim() || undefined,
  };

  const psa = productValues(env, "psa");
  if (psa) {
    config.psa = {
      site: normalizePsaSite(psa.CW_PSA_SITE),
      companyId: psa.CW_PSA_COMPANY_ID,
      publicKey: psa.CW_PSA_PUBLIC_KEY,
      privateKey: psa.CW_PSA_PRIVATE_KEY,
      clientId: psa.CW_PSA_CLIENT_ID,
      version: env.CW_PSA_VERSION?.trim() || undefined,
    };
  }

  const tenantId = env.AZURE_TENANT_ID?.trim();
  const entraClientId = env.AZURE_CLIENT_ID?.trim();
  if (tenantId && entraClientId) {
    config.entra = { tenantId, clientId: entraClientId };
  } else if (tenantId || entraClientId) {
    throw new Error("Incomplete Entra configuration: set both AZURE_TENANT_ID and AZURE_CLIENT_ID");
  }

  const auto = productValues(env, "automate");
  if (auto) {
    config.automate = {
      // The browser address of an Automate server is https://host/automate/ and
      // that is what gets pasted; the REST API is at https://host/cwa/api/v1.
      // Reduce either form, or the API path itself, to the server root.
      baseUrl: auto.CW_AUTOMATE_URL.replace(/\/+$/, "")
        .replace(/\/cwa\/api\/v1$/i, "")
        .replace(/\/automate$/i, ""),
      username: auto.CW_AUTOMATE_USERNAME,
      password: auto.CW_AUTOMATE_PASSWORD,
      clientId: auto.CW_AUTOMATE_CLIENT_ID,
      totpSecret: env.CW_AUTOMATE_TOTP_SECRET?.trim() || undefined,
    };
  }


  config.gates = { psa: gateFromEnv(env, "psa"), automate: gateFromEnv(env, "automate") };
  return config;
}
