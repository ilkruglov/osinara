-- One low-balance alert per family owner per UTC day: a claim taken before the Telegram send,
-- completed after it; an unclear delivery keeps its diagnostic code and is never retried.
CREATE TABLE owner_balance_alerts (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  alert_date date NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  diagnostic_code text,
  PRIMARY KEY (family_id, alert_date)
);

-- The balance at the time of each digest: the difference between two mornings is the day's spend,
-- counting every process on the key, which the bot's own usage logs never see.
ALTER TABLE owner_health_digests ADD COLUMN balance_usd numeric(12, 2);
