import { describe, expect, it } from "vitest";
import { incompleteConfigMessage, loadConfig, normalizePsaSite, productStatus } from "../src/config.js";

describe("normalizePsaSite", () => {
  it("adds the api- prefix for cloud hosts", () => {
    expect(normalizePsaSite("na.myconnectwise.net")).toBe("api-na.myconnectwise.net");
    expect(normalizePsaSite("eu.myconnectwise.net")).toBe("api-eu.myconnectwise.net");
    expect(normalizePsaSite("staging.connectwisedev.com")).toBe("api-staging.connectwisedev.com");
  });

  it("keeps already-correct cloud hosts", () => {
    expect(normalizePsaSite("api-na.myconnectwise.net")).toBe("api-na.myconnectwise.net");
  });

  it("strips protocol and paths", () => {
    expect(normalizePsaSite("https://na.myconnectwise.net/v4_6_release/apis/3.0")).toBe(
      "api-na.myconnectwise.net",
    );
  });

  it("leaves on-premise hosts untouched", () => {
    expect(normalizePsaSite("cw.example.com")).toBe("cw.example.com");
  });
});

const PSA_ENV = {
  CW_PSA_SITE: "na.myconnectwise.net",
  CW_PSA_COMPANY_ID: "mycompany",
  CW_PSA_PUBLIC_KEY: "pub",
  CW_PSA_PRIVATE_KEY: "priv",
  CW_PSA_CLIENT_ID: "guid",
};

describe("loadConfig", () => {
  it("builds PSA config when all vars are present", () => {
    const config = loadConfig({ ...PSA_ENV, MCP_AUTH_TOKEN: "tok" });
    expect(config.psa).toMatchObject({ site: "api-na.myconnectwise.net", companyId: "mycompany" });
    expect(config.authToken).toBe("tok");
    expect(config.automate).toBeUndefined();
  });

  it("throws on partial PSA config", () => {
    expect(() => loadConfig({ CW_PSA_SITE: "na.myconnectwise.net" })).toThrow(/missing/i);
  });

  it("omits PSA entirely when no vars are set", () => {
    const config = loadConfig({});
    expect(config.psa).toBeUndefined();
    expect(config.port).toBe(8080);
  });

  it("enables Entra auth when both vars are present, throws on partial", () => {
    const config = loadConfig({ ...PSA_ENV, AZURE_TENANT_ID: "tid", AZURE_CLIENT_ID: "cid" });
    expect(config.entra).toEqual({ tenantId: "tid", clientId: "cid" });
    expect(() => loadConfig({ ...PSA_ENV, AZURE_TENANT_ID: "tid" })).toThrow(/AZURE_CLIENT_ID/);
  });

  it("enables automate only when all four vars are present", () => {
    const config = loadConfig({
      ...PSA_ENV,
      CW_AUTOMATE_URL: "https://automate.example.com/",
      CW_AUTOMATE_USERNAME: "user",
      CW_AUTOMATE_PASSWORD: "pass",
      CW_AUTOMATE_CLIENT_ID: "guid",
    });
    expect(config.automate?.baseUrl).toBe("https://automate.example.com");
  });

  it("strips the web UI path from an Automate URL, since the API lives at the server root", () => {
    // The browser address of an Automate server is https://host/automate/, and
    // that is what people paste. The REST API is at https://host/cwa/api/v1;
    // keeping /automate in the base yields a 405 from the token endpoint.
    for (const url of ["https://rmm.example.com/automate", "https://rmm.example.com/Automate/", "https://rmm.example.com/automate/cwa/api/v1"]) {
      const config = loadConfig({
        ...PSA_ENV,
        CW_AUTOMATE_URL: url,
        CW_AUTOMATE_USERNAME: "user",
        CW_AUTOMATE_PASSWORD: "pass",
        CW_AUTOMATE_CLIENT_ID: "guid",
      });
      expect(config.automate?.baseUrl, url).toBe("https://rmm.example.com");
    }
  });

  it("enables screenconnect only when all three vars are present", () => {
    expect(loadConfig(PSA_ENV).screenconnect).toBeUndefined();
    const config = loadConfig({
      ...PSA_ENV,
      CW_SCREENCONNECT_URL: "https://x.screenconnect.com/",
      CW_SCREENCONNECT_USERNAME: "admin",
      CW_SCREENCONNECT_PASSWORD: "pw",
    });
    expect(config.screenconnect).toEqual({
      baseUrl: "https://x.screenconnect.com",
      username: "admin",
      password: "pw",
    });
  });

  it("treats a host's unexpanded ${user_config.x} placeholder as unset", () => {
    // Claude Desktop substitutes optional user_config fields the user never
    // filled in as the literal template text, not as an empty string.
    const config = loadConfig({
      ...PSA_ENV,
      CW_PSA_VERSION: "${user_config.psa_version}",
      CW_AUTOMATE_URL: "${user_config.automate_url}",
      CW_AUTOMATE_USERNAME: "${user_config.automate_username}",
      CW_AUTOMATE_PASSWORD: "${user_config.automate_password}",
      CW_AUTOMATE_CLIENT_ID: "${user_config.automate_client_id}",
      CW_SCREENCONNECT_URL: "${user_config.screenconnect_url}",
      CW_SCREENCONNECT_USERNAME: "${user_config.screenconnect_username}",
      CW_SCREENCONNECT_PASSWORD: "${user_config.screenconnect_password}",
    });
    expect(config.psa?.version).toBeUndefined();
    expect(config.automate).toBeUndefined();
    expect(config.screenconnect).toBeUndefined();
  });

  it("rejects a half-filled Automate form and names the field that is empty", () => {
    // The real failure this server was reported for: Claude Desktop's Automate
    // settings held a URL, a clientId and a password but no username, so the
    // partial config was silently ignored and the extension looked broken.
    expect(() =>
      loadConfig({
        ...PSA_ENV,
        CW_AUTOMATE_URL: "https://rmm.example.com",
        CW_AUTOMATE_USERNAME: "${user_config.automate_username}",
        CW_AUTOMATE_PASSWORD: "pw",
        CW_AUTOMATE_CLIENT_ID: "cid",
      }),
    ).toThrow(/CW_AUTOMATE_USERNAME \(Settings > Extensions field "Automate username"\)/);
  });

  it("rejects a half-filled Control form the same way", () => {
    expect(() =>
      loadConfig({
        ...PSA_ENV,
        CW_SCREENCONNECT_URL: "https://x.screenconnect.com",
        CW_SCREENCONNECT_USERNAME: "admin",
      }),
    ).toThrow(/CW_SCREENCONNECT_PASSWORD \(Settings > Extensions field "Control password"\)/);
  });

  it("names every missing PSA variable with its settings field", () => {
    expect(() => loadConfig({ CW_PSA_SITE: "na.myconnectwise.net" })).toThrow(
      /CW_PSA_COMPANY_ID \(Settings > Extensions field "PSA company id"\)/,
    );
  });
});

describe("productStatus", () => {
  it("separates 'nothing set' from 'half set'", () => {
    expect(productStatus({}, "automate")).toMatchObject({ set: [] });
    const partial = productStatus({ CW_AUTOMATE_URL: "https://rmm.example.com" }, "automate");
    expect(partial.set).toEqual(["CW_AUTOMATE_URL"]);
    expect(partial.missing.map((v) => v.env)).toEqual([
      "CW_AUTOMATE_USERNAME",
      "CW_AUTOMATE_PASSWORD",
      "CW_AUTOMATE_CLIENT_ID",
    ]);
  });

  it("ignores unexpanded placeholders when deciding what is set", () => {
    const status = productStatus({ CW_AUTOMATE_URL: "${user_config.automate_url}" }, "automate");
    expect(status.set).toEqual([]);
  });

  it("builds a message a Claude Desktop user can act on", () => {
    const { missing } = productStatus({}, "screenconnect");
    const message = incompleteConfigMessage("screenconnect", missing);
    expect(message).toContain("ConnectWise Control (ScreenConnect)");
    expect(message).toContain('Settings > Extensions field "Control (ScreenConnect) URL"');
  });
});
