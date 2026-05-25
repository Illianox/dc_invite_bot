import { EmbedBuilder, type Client, TextChannel } from "discord.js";
import { env } from "../config/env.js";
import type { Repository } from "../database/repositories/repository.js";

export class LogDispatcher {
  public constructor(private readonly client: Client, private readonly repository: Repository) {}

  public async dispatch(): Promise<void> {
    const channel = await this.client.channels.fetch(env.ADMIN_LOG_CHANNEL_ID).catch(() => null);
    if (!(channel instanceof TextChannel)) return;

    for (const log of await this.repository.pendingLogs()) {
      try {
        await channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(log.severity === "error" ? 0xed4245 : log.severity === "warn" ? 0xfee75c : 0x5865f2)
              .setTitle(logTitle(log.event_type))
              .setDescription(log.details.slice(0, 4000))
              .setTimestamp()
          ]
        });
        await this.repository.markLogSent(log.id);
      } catch (error) {
        const attempt = log.discord_attempt_count + 1;
        const retryMs = Math.min(300_000, 2 ** attempt * 5_000);
        await this.repository.markLogFailed(log.id, attempt, new Date(Date.now() + retryMs), String(error));
      }
    }
  }
}

function logTitle(eventType: string): string {
  const titles: Record<string, string> = {
    admin_assign: "Einladung manuell zugeordnet",
    admin_revoke: "Einladung widerrufen",
    cleanup_error: "Fehler bei der Bereinigung",
    interaction_error: "Fehler bei einer Aktion",
    invite_created: "Invite erstellt",
    invite_deleted: "Invite geloescht",
    invite_sync_error: "Fehler beim Invite-Abgleich",
    join_processing_error: "Fehler bei der Beitrittsverarbeitung",
    join_qualification_error: "Fehler bei der Einladungspruefung",
    join_startup_recovery: "Beitritt nach Neustart wiederhergestellt",
    log_dispatch_error: "Fehler beim Adminlog-Versand",
    member_remove_error: "Fehler beim Austritt",
    member_update_error: "Fehler bei Mitgliedsaktualisierung",
    referral_left: "Eingeladenes Mitglied verlassen",
    referral_non_referral: "Keine gewertete Einladung",
    referral_pending: "Einladung wartet",
    referral_qualified: "Einladung zaehlt",
    referral_reward_active: "Referral Reward aktiv",
    referral_reward_blocked: "Referral Reward blockiert",
    referral_reward_check_error: "Fehler bei Reward-Pruefung",
    referral_reward_completed: "Referral Reward abgeschlossen",
    referral_reward_dry_run: "Referral Reward Dry-Run",
    referral_reward_failed: "Referral Reward fehlgeschlagen",
    referral_reward_paid: "Referral Belohnung ausgezahlt",
    referral_reward_retry: "Referral Reward Retry",
    referral_reward_start_minutes_saved: "Referral Start-Minuten gespeichert",
    referral_reward_step_reached: "Referral Etappe erreicht",
    referral_reward_unblocked: "Referral Reward entsperrt",
    referral_unqualified: "Einladung zaehlt nicht mehr",
    referral_unresolved: "Einladung unklar",
    role_sync_error: "Fehler beim Rollenabgleich",
    startup_error: "Fehler beim Bot-Start"
  };
  return titles[eventType] ?? eventType;
}
