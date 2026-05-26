import { EmbedBuilder, type Client, TextChannel } from "discord.js";
import { env } from "../config/env.js";
import type { Repository } from "../database/repositories/repository.js";

export class LogDispatcher {
  public constructor(private readonly client: Client, private readonly repository: Repository) {}

  public async dispatch(): Promise<void> {
    const channel = await this.client.channels.fetch(env.ADMIN_LOG_CHANNEL_ID).catch(() => null);
    if (!(channel instanceof TextChannel)) return;

    for (const log of await this.repository.pendingLogs()) {
      if (!shouldSendToDiscord(log.event_type, log.severity)) {
        await this.repository.markLogSent(log.id);
        continue;
      }
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

function shouldSendToDiscord(eventType: string, severity: "info" | "warn" | "error"): boolean {
  if (severity === "error") return true;
  return new Set([
    "admin_assign",
    "admin_revoke",
    "invite_deleted",
    "join_startup_recovery",
    "referral_unresolved",
    "referral_reward_active",
    "referral_reward_blocked",
    "referral_reward_failed",
    "referral_reward_progress_updated",
    "referral_reward_retry",
    "referral_reward_unblocked"
  ]).has(eventType);
}

function logTitle(eventType: string): string {
  const titles: Record<string, string> = {
    admin_assign: "Spielerwerbung manuell zugeordnet",
    admin_revoke: "Spielerwerbung widerrufen",
    cleanup_error: "Fehler bei der Bereinigung",
    interaction_error: "Fehler bei einer Aktion",
    invite_created: "Einladungslink erstellt",
    invite_deleted: "Einladungslink geloescht",
    invite_sync_error: "Fehler beim Einladungs-Abgleich",
    join_processing_error: "Fehler bei der Beitrittsverarbeitung",
    join_qualification_error: "Fehler bei der Spielerwerbungs-Pruefung",
    join_startup_recovery: "Beitritt nach Neustart wiederhergestellt",
    log_dispatch_error: "Fehler beim Adminlog-Versand",
    member_remove_error: "Fehler beim Austritt",
    member_update_error: "Fehler bei Mitgliedsaktualisierung",
    referral_left: "Geworbener Spieler hat den Server verlassen",
    referral_non_referral: "Keine Spielerwerbung erkannt",
    referral_pending: "Spielerwerbung wartet",
    referral_qualified: "Spielerwerbung erfolgreich",
    referral_reward_active: "Spielerwerbung aktiviert",
    referral_reward_blocked: "Spielerwerbung blockiert",
    referral_reward_check_error: "Fehler bei Spielerwerbungs-Pruefung",
    referral_reward_completed: "Spielerwerbung abgeschlossen",
    referral_reward_dry_run: "Spielerwerbung Dry-Run",
    referral_reward_failed: "Spielerwerbung fehlgeschlagen",
    referral_reward_paid: "Spielerwerbung verarbeitet",
    referral_reward_progress_updated: "Spielerwerbungs-Fortschritt aktualisiert",
    referral_reward_retry: "Spielerwerbung Retry",
    referral_reward_start_minutes_saved: "Start-Spielzeit gespeichert",
    referral_reward_step_reached: "Spielerwerbungs-Fortschritt",
    referral_reward_unblocked: "Spielerwerbung entsperrt",
    referral_unqualified: "Spielerwerbung nicht mehr erfolgreich",
    referral_unresolved: "Spielerwerbung unklar",
    role_sync_error: "Fehler beim Rollenabgleich",
    startup_error: "Fehler beim Bot-Start"
  };
  return titles[eventType] ?? eventType;
}
