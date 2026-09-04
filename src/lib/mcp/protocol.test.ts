import { describe, it, expect } from "vitest";
import { negotiateProtocol, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol";

describe("negotiateProtocol", () => {
  it("echoes every version it claims to support", () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiateProtocol(v)).toBe(v);
    }
  });

  it("falls back for a version from the future", () => {
    expect(negotiateProtocol("2099-01-01")).toBe(PROTOCOL_VERSION);
  });

  // A client that sends nothing, or something that is not a version string at
  // all, must still get a usable answer rather than undefined echoed back --
  // that is what would actually break a handshake.
  it.each([undefined, null, "", "garbage", 20250618, {}, ["2025-06-18"]])(
    "falls back for %o",
    (bad) => {
      expect(negotiateProtocol(bad)).toBe(PROTOCOL_VERSION);
    },
  );

  it("never answers with a version it does not support", () => {
    for (const input of ["2025-06-18", "2024-11-05", "nonsense", undefined]) {
      expect(SUPPORTED_PROTOCOL_VERSIONS.has(negotiateProtocol(input))).toBe(true);
    }
  });
});
