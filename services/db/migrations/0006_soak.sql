-- Muestras periódicas del soak F3 (RSS/CPU y contadores shadow).
-- Idempotente para aplicarse con psql sin runner.

CREATE SCHEMA IF NOT EXISTS shadow;

CREATE TABLE IF NOT EXISTS shadow.soak_samples (
  sampled_at bigint PRIMARY KEY,
  service_rss_kb bigint NOT NULL,
  service_cpu_percent real NOT NULL,
  postgres_rss_kb bigint NOT NULL,
  runs bigint NOT NULL,
  decisions bigint NOT NULL,
  mismatches bigint NOT NULL,
  invariant_violations bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shadow_soak_samples_sampled_at
  ON shadow.soak_samples (sampled_at DESC);
