ALTER TABLE join_processing_queue
  ADD COLUMN invitee_discord_name VARCHAR(100) NULL AFTER invitee_discord_id;
