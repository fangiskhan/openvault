import { describe, it, expect, afterEach, vi } from "vitest";
import { secretsRequired, isPublicOptIn, auditSecrets, assertSecureBoot } from "./security";

// These read process.env. vi.stubEnv handles NODE_ENV's readonly type and is
// undone by vi.unstubAllEnvs(), giving each test a clean, fully-specified slate.
const KEYS = ["NODE_ENV", "OPENVAULT_PUBLIC", "APP_PASSWORD", "AUTH_SECRET", "MCP_TOKEN"] as const;

function set(env: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const k of KEYS) vi.stubEnv(k, env[k]);
}

// A fully-configured production environment with strong secrets.
const SECURE = {
  NODE_ENV: "production",
  APP_PASSWORD: "hunter2",
  AUTH_SECRET: "a-genuinely-long-random-string",
  MCP_TOKEN: "tok_abc123",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("secretsRequired / isPublicOptIn", () => {
  it("requires secrets in production without the public opt-in", () => {
    set({ NODE_ENV: "production", OPENVAULT_PUBLIC: undefined });
    expect(secretsRequired()).toBe(true);
  });

  it("does not require secrets in development", () => {
    set({ NODE_ENV: "development", OPENVAULT_PUBLIC: undefined });
    expect(secretsRequired()).toBe(false);
  });

  it("lets OPENVAULT_PUBLIC=1 opt out of the production requirement", () => {
    set({ NODE_ENV: "production", OPENVAULT_PUBLIC: "1" });
    expect(isPublicOptIn()).toBe(true);
    expect(secretsRequired()).toBe(false);
  });
});

describe("auditSecrets", () => {
  it("is clean when every gate secret is set and strong", () => {
    set(SECURE);
    expect(auditSecrets()).toEqual([]);
  });

  it("flags an empty APP_PASSWORD and MCP_TOKEN", () => {
    set({ ...SECURE, APP_PASSWORD: undefined, MCP_TOKEN: undefined });
    expect(auditSecrets().map((p) => p.name)).toEqual(["APP_PASSWORD", "MCP_TOKEN"]);
  });

  it("flags AUTH_SECRET left at a known placeholder when a password is set", () => {
    set({ ...SECURE, AUTH_SECRET: "change-me-to-a-long-random-string" });
    expect(auditSecrets().map((p) => p.name)).toEqual(["AUTH_SECRET"]);
  });

  it("does not flag AUTH_SECRET when there's no password gate to protect", () => {
    set({ ...SECURE, APP_PASSWORD: undefined, AUTH_SECRET: "dev-only-change-me" });
    // APP_PASSWORD is reported; AUTH_SECRET is moot without a gate.
    expect(auditSecrets().map((p) => p.name)).toEqual(["APP_PASSWORD"]);
  });
});

describe("assertSecureBoot", () => {
  it("throws (refuses to start) in production with open gates", () => {
    set({ NODE_ENV: "production", OPENVAULT_PUBLIC: undefined });
    expect(() => assertSecureBoot()).toThrow(/refusing to start/i);
  });

  it("does not throw in production when fully configured", () => {
    set(SECURE);
    expect(() => assertSecureBoot()).not.toThrow();
  });

  it("does not throw in development with open gates", () => {
    set({ NODE_ENV: "development", APP_PASSWORD: undefined, MCP_TOKEN: undefined });
    expect(() => assertSecureBoot()).not.toThrow();
  });

  it("does not throw with an explicit public opt-in", () => {
    set({ NODE_ENV: "production", OPENVAULT_PUBLIC: "1", APP_PASSWORD: undefined, MCP_TOKEN: undefined });
    expect(() => assertSecureBoot()).not.toThrow();
  });
});
