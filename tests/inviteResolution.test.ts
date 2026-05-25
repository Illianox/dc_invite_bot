import { describe, expect, it } from "vitest";
import { resolveInviteChange } from "../src/services/inviteResolution.js";

describe("resolveInviteChange", () => {
  it("creates pending only for one exact managed invite increment", () => {
    const result = resolveInviteChange(new Map([["abc", 2]]), new Map([["abc", 3]]), new Set(["abc"]));
    expect(result).toEqual({ kind: "pending", inviteCode: "abc", delta: 1, consumedUses: new Map([["abc", 3]]) });
  });

  it("consumes one use when one managed invite has multiple fresh joins", () => {
    const result = resolveInviteChange(new Map([["abc", 2]]), new Map([["abc", 4]]), new Set(["abc"]));
    expect(result).toEqual({ kind: "pending", inviteCode: "abc", delta: 2, consumedUses: new Map([["abc", 3]]) });
  });

  it("rejects increments on multiple managed invites", () => {
    const result = resolveInviteChange(
      new Map([["abc", 2], ["def", 5]]),
      new Map([["abc", 3], ["def", 6]]),
      new Set(["abc", "def"])
    );
    expect(result.kind).toBe("unresolved");
  });

  it("keeps unchanged managed links unresolved", () => {
    const result = resolveInviteChange(new Map([["abc", 2]]), new Map([["abc", 2]]), new Set(["abc"]));
    expect(result.kind).toBe("unresolved");
  });

  it("classifies a join without managed links as non-referral", () => {
    const result = resolveInviteChange(new Map([["abc", 2]]), new Map([["abc", 2]]), new Set());
    expect(result).toEqual({ kind: "non_referral" });
  });

  it("requires a baseline", () => {
    expect(resolveInviteChange(new Map(), new Map(), new Set()).kind).toBe("unresolved");
  });
});
