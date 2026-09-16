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
}

export interface ScreenConnectConfig {
  baseUrl: string;
  username: string;
  password: string;
}

export interface EntraConfig {
  tenantId: string;
  clientId: string;
}

export interface AppConfig {
  port: number;
  authToken?: string;
  entra?: EntraConfig;
  psa?: PsaConfig;
  automate?: AutomateConfig;
  screenconnect?: ScreenConnectConfig;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config: AppConfig = {
    port: Number(env.PORT) || 8080,
    authToken: env.MCP_AUTH_TOKEN?.trim() || undefined,
  };

  const psaVars = {
    site: env.CW_PSA_SITE,
    companyId: env.CW_PSA_COMPANY_ID,
    publicKey: env.CW_PSA_PUBLIC_KEY,
    privateKey: env.CW_PSA_PRIVATE_KEY,
    clientId: env.CW_PSA_CLIENT_ID,
  };
  const psaMissing = Object.entries(psaVars)
    .filter(([, v]) => !v?.trim())
    .map(([k]) => k);
  if (psaMissing.length === 0) {
    config.psa = {
      site: normalizePsaSite(psaVars.site!),
      companyId: psaVars.companyId!.trim(),
      publicKey: psaVars.publicKey!.trim(),
      privateKey: psaVars.privateKey!.trim(),
      clientId: psaVars.clientId!.trim(),
      version: env.CW_PSA_VERSION?.trim() || undefined,
    };
  } else if (psaMissing.length < Object.keys(psaVars).length) {
    throw new Error(
      `Incomplete ConnectWise PSA configuration; missing: ${psaMissing
        .map((k) => `CW_PSA_${k.replace(/([A-Z])/g, "_$1").toUpperCase()}`)
        .join(", ")}`,
    );
  }

  const tenantId = env.AZURE_TENANT_ID?.trim();
  const entraClientId = env.AZURE_CLIENT_ID?.trim();
  if (tenantId && entraClientId) {
    config.entra = { tenantId, clientId: entraClientId };
  } else if (tenantId || entraClientId) {
    throw new Error("Incomplete Entra configuration: set both AZURE_TENANT_ID and AZURE_CLIENT_ID");
  }

  const auto = {
    baseUrl: env.CW_AUTOMATE_URL,
    username: env.CW_AUTOMATE_USERNAME,
    password: env.CW_AUTOMATE_PASSWORD,
    clientId: env.CW_AUTOMATE_CLIENT_ID,
  };
  if (Object.values(auto).every((v) => v?.trim())) {
    config.automate = {
      // The browser address of an Automate server is https://host/automate/ and
      // that is what gets pasted; the REST API is at https://host/cwa/api/v1.
      // Reduce either form, or the API path itself, to the server root.
      baseUrl: auto
        .baseUrl!.trim()
        .replace(/\/+$/, "")
        .replace(/\/cwa\/api\/v1$/i, "")
        .replace(/\/automate$/i, ""),
      username: auto.username!.trim(),
      password: auto.password!.trim(),
      clientId: auto.clientId!.trim(),
    };
  }

  const sc = {
    baseUrl: env.CW_SCREENCONNECT_URL,
    username: env.CW_SCREENCONNECT_USERNAME,
    password: env.CW_SCREENCONNECT_PASSWORD,
  };
  if (Object.values(sc).every((v) => v?.trim())) {
    config.screenconnect = {
      baseUrl: sc.baseUrl!.trim().replace(/\/+$/, ""),
      username: sc.username!.trim(),
      password: sc.password!.trim(),
    };
  }

  return config;
}
