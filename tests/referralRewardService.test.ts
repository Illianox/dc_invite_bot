import { describe, expect, it } from "vitest";
import type { RconServerConfig, ReferralRewardsConfig } from "../src/config/referralRewards.js";
import { MemoryRepository } from "../src/database/repositories/memoryRepository.js";
import { MemoryPlayerStatsRepository } from "../src/services/playerStatsRepository.js";
import { RconRewardClient, type RewardCommandResult } from "../src/services/rconClient.js";
import { ReferralRewardService } from "../src/services/referralRewardService.js";

const rewardServer: RconServerConfig = { name: "reward", host: "127.0.0.1", port: 27020, password: "" };
const clusterServer: RconServerConfig = { name: "cluster-a", host: "127.0.0.1", port: 27021, password: "" };

function config(overrides: Partial<ReferralRewardsConfig> = {}): ReferralRewardsConfig {
  return {
    enabled: true,
    dryRun: true,
    checkIntervalSeconds: 300,
    maxRetryAttempts: 5,
    retryDelaySeconds: 300,
    multiServerRewards: false,
    rewardServer,
    clusterServers: [clusterServer],
    ...overrides
  };
}

const defaultRewardSteps = [
  {
    key: "10h",
    requiredMinutes: 600,
    inviterCommands: ["addpoints {eos_id} 10000"],
    invitedCommands: ["addpoints {eos_id} 5000"],
    enabled: true
  }
];

class RecordingRconClient extends RconRewardClient {
  public readonly calls: Array<{ server: string; command: string; dryRun: boolean }> = [];
  public fail = false;

  public override async execute(server: RconServerConfig, command: string, dryRun: boolean): Promise<RewardCommandResult> {
    this.calls.push({ server: server.name, command, dryRun });
    if (this.fail) throw new Error("rcon down");
    return { serverName: server.name, command, status: dryRun ? "dry_run" : "success" };
  }
}

async function qualifiedReferral(): Promise<{ repository: MemoryRepository; stats: MemoryPlayerStatsRepository; referralId: number }> {
  const repository = new MemoryRepository();
  repository.setRewardSteps(defaultRewardSteps);
  const stats = new MemoryPlayerStatsRepository();
  const queueId = await repository.enqueueJoin("guild", "invited", new Date());
  const referralId = await repository.resolveQueuedJoin(queueId, {
    guildId: "guild",
    inviterId: "inviter",
    inviteeId: "invited",
    inviteCode: "code",
    joinedAt: new Date(),
    status: "pending",
    reason: "test"
  }, new Map());
  const referral = await repository.findCurrentReferral("guild", "invited");
  await repository.transitionReferral(referral!, "qualified", "referral_qualified", null, "linked");
  stats.setLink("inviter", "EOS_INVITER");
  stats.setLink("invited", "EOS_INVITED");
  stats.setMinutes("EOS_INVITED", 200);
  return { repository, stats, referralId };
}

async function addQualifiedReferral(repository: MemoryRepository, inviteeId: string, inviterId: string): Promise<number> {
  const queueId = await repository.enqueueJoin("guild", inviteeId, new Date());
  const referralId = await repository.resolveQueuedJoin(queueId, {
    guildId: "guild",
    inviterId,
    inviteeId,
    inviteCode: `code-${inviteeId}`,
    joinedAt: new Date(),
    status: "pending",
    reason: "test"
  }, new Map());
  const referral = await repository.findCurrentReferral("guild", inviteeId);
  await repository.transitionReferral(referral!, "qualified", "referral_qualified", null, "linked");
  return referralId;
}

describe("ReferralRewardService", () => {
  it("uses start_minutes and pays only after minutes earned since invite", async () => {
    const { repository, stats, referralId } = await qualifiedReferral();
    const rcon = new RecordingRconClient();
    const service = new ReferralRewardService(repository, stats, rcon, config({ dryRun: false }));

    expect(await service.checkAll("guild")).toEqual({ checked: 1, paid: 0 });
    stats.setMinutes("EOS_INVITED", 799);
    expect(await service.checkAll("guild")).toEqual({ checked: 1, paid: 0 });
    stats.setMinutes("EOS_INVITED", 800);
    expect(await service.checkAll("guild")).toEqual({ checked: 1, paid: 1 });

    expect(rcon.calls).toEqual([
      { server: "reward", command: "addpoints EOS_INVITER 10000", dryRun: false },
      { server: "reward", command: "addpoints EOS_INVITED 5000", dryRun: false }
    ]);
    expect((await repository.listStepProgress(referralId))[0]?.status).toBe("paid");
    expect(await service.checkAll("guild")).toEqual({ checked: 0, paid: 0 });
  });

  it("uses only rewardServer by default and all cluster servers only when enabled", async () => {
    const first = await qualifiedReferral();
    const firstRcon = new RecordingRconClient();
    const firstService = new ReferralRewardService(first.repository, first.stats, firstRcon, config({ dryRun: false }));
    await firstService.checkAll("guild");
    first.stats.setMinutes("EOS_INVITED", 800);
    await firstService.checkAll("guild");
    expect(firstRcon.calls.map((call) => call.server)).toEqual(["reward", "reward"]);

    const second = await qualifiedReferral();
    const secondRcon = new RecordingRconClient();
    const secondService = new ReferralRewardService(second.repository, second.stats, secondRcon, config({ dryRun: false, multiServerRewards: true }));
    await secondService.checkAll("guild");
    second.stats.setMinutes("EOS_INVITED", 800);
    await secondService.checkAll("guild");
    expect(secondRcon.calls.map((call) => call.server)).toEqual(["cluster-a", "cluster-a"]);
  });

  it("retries failed RCON rewards before marking the step failed", async () => {
    const { repository, stats, referralId } = await qualifiedReferral();
    const rcon = new RecordingRconClient();
    rcon.fail = true;
    const service = new ReferralRewardService(repository, stats, rcon, config({ dryRun: false, maxRetryAttempts: 2, retryDelaySeconds: 1 }));
    await service.checkAll("guild");
    stats.setMinutes("EOS_INVITED", 800);

    await service.checkAll("guild");
    expect((await repository.listStepProgress(referralId))[0]?.status).toBe("retry");

    await repository.resetStepForRetry(referralId, "10h");
    await service.checkAll("guild");
    expect((await repository.listStepProgress(referralId))[0]?.status).toBe("failed");
  });

  it("does not mark steps paid in dryRun mode", async () => {
    const { repository, stats, referralId } = await qualifiedReferral();
    const rcon = new RecordingRconClient();
    const service = new ReferralRewardService(repository, stats, rcon, config());
    await service.checkAll("guild");
    stats.setMinutes("EOS_INVITED", 800);

    expect(await service.checkAll("guild")).toEqual({ checked: 1, paid: 0 });
    expect(rcon.calls.every((call) => call.dryRun)).toBe(true);
    expect((await repository.listStepProgress(referralId))[0]?.status).toBe("pending");
  });

  it("blocks a second reward referral for the same invited EOS ID", async () => {
    const { repository, stats } = await qualifiedReferral();
    const rcon = new RecordingRconClient();
    const service = new ReferralRewardService(repository, stats, rcon, config({ dryRun: false }));
    await service.checkAll("guild");

    await addQualifiedReferral(repository, "invited-again", "inviter-2");
    stats.setLink("inviter-2", "EOS_INVITER_2");
    stats.setLink("invited-again", "EOS_INVITED");
    await service.checkAll("guild");

    const second = await repository.findRewardReferralByInvitee("guild", "invited-again");
    expect(second?.rewardStatus).toBe("blocked");
    expect(second?.blockedReason).toContain("EOS ID");
  });

  it("remembers EOS identities locally even if the external link later disappears", async () => {
    const repository = new MemoryRepository();
    repository.setRewardSteps(defaultRewardSteps);
    await repository.rememberPlayerIdentity("guild", "old-discord", "EOS_RETURNING");
    await addQualifiedReferral(repository, "new-discord", "inviter");
    const stats = new MemoryPlayerStatsRepository();
    stats.setLink("inviter", "EOS_INVITER");
    stats.setLink("new-discord", "EOS_RETURNING");
    stats.setMinutes("EOS_RETURNING", 200);
    const service = new ReferralRewardService(repository, stats, new RecordingRconClient(), config({ dryRun: false }));

    await service.checkAll("guild");

    const referral = await repository.findRewardReferralByInvitee("guild", "new-discord");
    expect(referral?.rewardStatus).toBe("blocked");
    expect(referral?.blockedReason).toContain("anderen Discord-Account");
  });
});
