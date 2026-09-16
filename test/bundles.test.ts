// The per-product bundles.
//
// Three .mcpb bundles are built from this one server: PSA, Automate and Control,
// each from a manifest under manifests/ that configures exactly one product.
// Two things make that work, and both are pinned here: the stdio entry starts
// with any one product configured (it used to insist on PSA), and each product
// manifest lists exactly that product's tools and asks for exactly that
// product's credentials.
//
// Every credential here is synthetic and no test reaches ConnectWise.

import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { TOOL_CATALOG } from "../src/tools/catalog.js";
import type { ToolSurface } from "../src/tools/spec.js";

const run = promisify(execFile);

const PRODUCT_ENV: Record<ToolSurface, Record<string, string>> = {
  psa: {
    CW_PSA_SITE: "api-na.myconnectwise.net",
    CW_PSA_COMPANY_ID: "mock-company",
    CW_PSA_PUBLIC_KEY: "mock-public-key",
    CW_PSA_PRIVATE_KEY: "mock-private-key-not-real",
    CW_PSA_CLIENT_ID: "mock-client-id",
  },
  automate: {
    CW_AUTOMATE_URL: "https://automate.example",
    CW_AUTOMATE_USERNAME: "mock-user",
    CW_AUTOMATE_PASSWORD: "mock-password-not-real",
    CW_AUTOMATE_CLIENT_ID: "mock-client-id",
  },
  control: {
    CW_SCREENCONNECT_URL: "https://control.example",
    CW_SCREENCONNECT_USERNAME: "mock-user",
    CW_SCREENCONNECT_PASSWORD: "mock-password-not-real",
  },
};

/** Environment with every CW_* variable removed, so only what a case adds is set. */
function bareEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name, value]) => !name.startsWith("CW_") && value !== undefined),
  ) as Record<string, string>;
}

/**
 * Start the built stdio entry with the given environment and report how it
 * ended. A server that starts never exits on its own, so the timeout ends it;
 * a refusal exits 1 before connecting. stdin is closed at once so a started
 * server sees EOF and exits cleanly rather than being killed.
 */
async function startStdio(env: Record<string, string>) {
  try {
    const { stderr } = await run(process.execPath, ["dist/stdio.js"], { env: { ...bareEnv(), ...env }, timeout: 3_000 });
    return { refused: false, stderr };
  } catch (error) {
    const err = error as { code?: number; killed?: boolean; stderr?: string };
    return { refused: err.code === 1 && !err.killed, stderr: err.stderr ?? "" };
  }
}

describe("stdio entry startup guard", () => {
  it("refuses to start with no product configured", async () => {
    const result = await startStdio({});
    expect(result.refused).toBe(true);
    expect(result.stderr).toMatch(/no ConnectWise product is configured/);
  });

  it.each(["psa", "automate", "control"] as ToolSurface[])("starts with only %s configured", async (surface) => {
    const result = await startStdio(PRODUCT_ENV[surface]);
    expect(result.refused).toBe(false);
    expect(result.stderr).toMatch(new RegExp(`${surface === "control" ? "control" : surface}=yes`));
  });
});

describe("per-product manifests", () => {
  const root = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const bundles: Array<{ surface: ToolSurface; name: string; envPrefix: string }> = [
    { surface: "psa", name: "connectwise-psa", envPrefix: "CW_PSA_" },
    { surface: "automate", name: "connectwise-automate", envPrefix: "CW_AUTOMATE_" },
    { surface: "control", name: "connectwise-control", envPrefix: "CW_SCREENCONNECT_" },
  ];

  it.each(bundles)("$name lists exactly its product's tools and credentials", ({ surface, name, envPrefix }) => {
    const manifest = JSON.parse(readFileSync(new URL(`../manifests/${name}.json`, import.meta.url), "utf8"));
    expect(manifest.name).toBe(name);
    expect(manifest.version).toBe(root.version);

    const expected = TOOL_CATALOG.filter((tool) => tool.surface === surface).map((tool) => tool.title);
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual(expected);

    const env = manifest.server.mcp_config.env as Record<string, string>;
    expect(Object.keys(env).length).toBeGreaterThan(0);
    for (const variable of Object.keys(env)) expect(variable.startsWith(envPrefix)).toBe(true);
    // Every credential the bundle asks for is required: there is no optional
    // product in a single-product bundle.
    for (const field of Object.values(manifest.user_config) as Array<{ required: boolean; title: string }>) {
      expect(field.required).toBe(true);
      expect(field.title).not.toMatch(/optional/i);
    }
    expect(manifest.icon).toBe(`assets/connectwise-${surface}-512.png`);
  });
});
