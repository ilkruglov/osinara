-- Задание провайдера на строке операции. 16 октября 2026 четыре правки в «Дизраптим» ушли в
-- ambiguous по таймауту опроса, а сверить их с PlusVibe было нечем: id задания не писался ни в
-- лог, ни сюда. Теперь клиент сообщает о созданном задании, и строка знает провайдера, модель и
-- id задания; неясный исход можно сверить с историей провайдера. Пишется только пока операция
-- идёт: завершённая строка свою историю не меняет.
ALTER TABLE image_generation_operations
  ADD COLUMN provider text CHECK (provider IS NULL OR char_length(provider) BETWEEN 1 AND 64),
  ADD COLUMN provider_model text CHECK (provider_model IS NULL OR char_length(provider_model) BETWEEN 1 AND 128),
  ADD COLUMN provider_job_id text CHECK (provider_job_id IS NULL OR char_length(provider_job_id) BETWEEN 1 AND 128);
