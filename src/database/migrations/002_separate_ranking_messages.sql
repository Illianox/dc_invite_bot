ALTER TABLE panel_messages
  MODIFY panel_type ENUM('main_panel', 'public_ranking', 'public_ranking_monthly', 'public_ranking_all_time') NOT NULL;

INSERT IGNORE INTO panel_messages (panel_type, guild_id, channel_id, message_id)
SELECT 'public_ranking_monthly', guild_id, channel_id, message_id
FROM panel_messages
WHERE panel_type = 'public_ranking';
