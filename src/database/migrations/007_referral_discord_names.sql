ALTER TABLE referrals
  ADD COLUMN inviter_discord_name VARCHAR(100) NULL AFTER inviter_discord_id,
  ADD COLUMN invitee_discord_name VARCHAR(100) NULL AFTER invitee_discord_id;
