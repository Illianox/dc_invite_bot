import { describe, expect, it, vi } from "vitest";
import { CooldownService } from "../src/services/cooldownService.js";

describe("CooldownService", () => {
  it("allows the first request and blocks repeated requests until expiry", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValueOnce(2_100);
    const service = new CooldownService();
    expect(service.take("user", 1_000)).toBe(0);
    expect(service.take("user", 1_000)).toBe(900);
    expect(service.take("user", 1_000)).toBe(0);
    vi.restoreAllMocks();
  });
});
