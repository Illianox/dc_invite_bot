import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../src/database/repositories/memoryRepository.js";
import { InviteService } from "../src/services/inviteService.js";

function inviteMap(uses: number): Map<string, { code: string; uses: number }> {
  return new Map([["abc", { code: "abc", uses }]]);
}

function invites(uses: Record<string, number>): Map<string, { code: string; uses: number }> {
  return new Map(Object.entries(uses).map(([code, count]) => [code, { code, uses: count }]));
}

function member(guild: unknown, id: string): any {
  return {
    id,
    guild,
    joinedAt: new Date(),
    user: { bot: false }
  };
}

describe("InviteService", () => {
  it("assigns multiple queued joins when one managed invite reports a burst increment", async () => {
    const repository = new MemoryRepository();
    await repository.createInvite("guild", "inviter", "abc", "channel", 0);

    const guild: any = {
      id: "guild",
      invites: {
        fetch: async () => inviteMap(3)
      },
      channels: {
        fetch: async () => null
      }
    };

    const service = new InviteService(repository);
    await service.establishBaseline({ ...guild, invites: { fetch: async () => inviteMap(0) } });

    await Promise.all([
      service.enqueueMemberJoin(member(guild, "invitee-1")),
      service.enqueueMemberJoin(member(guild, "invitee-2")),
      service.enqueueMemberJoin(member(guild, "invitee-3"))
    ]);

    for (const inviteeId of ["invitee-1", "invitee-2", "invitee-3"]) {
      const referral = await repository.findCurrentReferral("guild", inviteeId);
      expect(referral?.status).toBe("pending");
      expect(referral?.inviterDiscordId).toBe("inviter");
      expect(referral?.inviteCode).toBe("abc");
    }
  });

  it("keeps a burst unresolved when another managed invite catches up during the settle check", async () => {
    const repository = new MemoryRepository();
    await repository.createInvite("guild", "inviter-a", "abc", "channel", 0);
    await repository.createInvite("guild", "inviter-b", "def", "channel", 0);

    const fetches = [
      invites({ abc: 0, def: 0 }),
      invites({ abc: 2, def: 0 }),
      invites({ abc: 2, def: 1 })
    ];
    const guild: any = {
      id: "guild",
      invites: {
        fetch: async () => fetches.shift() ?? invites({ abc: 2, def: 1 })
      },
      channels: {
        fetch: async () => null
      }
    };

    const service = new InviteService(repository);
    await service.establishBaseline(guild);
    await service.enqueueMemberJoin(member(guild, "invitee"));

    const referral = await repository.findLatestAssignableReferral("guild", "invitee");
    expect(referral?.status).toBe("unresolved");
    expect(referral?.inviterDiscordId).toBeNull();
  });
});
