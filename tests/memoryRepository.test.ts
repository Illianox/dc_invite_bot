import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../src/database/repositories/memoryRepository.js";

describe("MemoryRepository", () => {
  it("stores and ranks qualified referrals without a database", async () => {
    const repository = new MemoryRepository();
    const queueId = await repository.enqueueJoin("guild", "invitee", "Invitee#0001", new Date());
    await repository.resolveQueuedJoin(queueId, {
      guildId: "guild",
      inviterId: "inviter",
      inviterName: "Inviter#0001",
      inviteeId: "invitee",
      inviteeName: "Invitee#0001",
      inviteCode: "code",
      joinedAt: new Date(),
      status: "pending",
      reason: "test"
    }, new Map([["code", 1]]));
    const pending = await repository.findCurrentReferral("guild", "invitee");
    expect(pending?.status).toBe("pending");
    expect(pending?.inviterDiscordName).toBe("Inviter#0001");
    expect(pending?.inviteeDiscordName).toBe("Invitee#0001");
    await repository.transitionReferral(pending!, "qualified", "referral_qualified", null, "verknuepft");
    const thisMonth = {
      start: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      end: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
    };
    expect(await repository.getRanking("guild", thisMonth, 10)).toEqual([{ inviterId: "inviter", total: 1 }]);
    expect(await repository.getRanking("guild", null, 10)).toEqual([{ inviterId: "inviter", total: 1 }]);
    expect(await repository.getRanking("guild", { start: thisMonth.end, end: new Date(thisMonth.end.getFullYear(), thisMonth.end.getMonth() + 1, 1) }, 10)).toEqual([]);
    const logs = await repository.pendingLogs();
    expect(logs.find((log) => log.event_type === "referral_pending")?.details).toContain("Eingeladen von:\n<@inviter>");
    expect(logs.find((log) => log.event_type === "referral_pending")?.details).toContain("Spielerwerbung wartet auf Verifizierung.");
    expect(logs.find((log) => log.event_type === "referral_qualified")?.details).toContain("Eingeladener Spieler:\n<@invitee>");
    expect(logs.find((log) => log.event_type === "referral_qualified")?.details).toContain("Spielerwerbung erfolgreich.");
  });

  it("prevents more than one active invite for a member", async () => {
    const repository = new MemoryRepository();
    await repository.createInvite("guild", "member", "one", "channel", 0);
    expect((await repository.pendingLogs())[0]?.details).toContain("wurde von <@member> erstellt");
    await expect(repository.createInvite("guild", "member", "two", "channel", 0)).rejects.toThrow();
  });
});
