-- Передача нити разговора при ротации сессии по лимиту ходов. Новая сессия начиналась с нуля:
-- факты живут в памяти, а о чём шла речь, что решили и что не закончено, терялось. Сводка
-- прошлой сессии пишется на строку новой и один раз попадает в ход, который первым её заберёт
-- (handoff_shown_at): два одновременных сообщения группы готовят контекст параллельно, и привязка
-- к первому ходу по курсору ленты могла бы потерять сводку. Размер, задержка и число исходных
-- записей рядом, чтобы по ним судить о цене и полноте.
ALTER TABLE conversation_sessions
  ADD COLUMN handoff_text text CHECK (handoff_text IS NULL OR char_length(handoff_text) <= 3000),
  ADD COLUMN handoff_generated_at timestamptz,
  ADD COLUMN handoff_shown_at timestamptz,
  ADD COLUMN handoff_latency_ms integer CHECK (handoff_latency_ms IS NULL OR handoff_latency_ms >= 0),
  ADD COLUMN handoff_source_entries integer CHECK (handoff_source_entries IS NULL OR handoff_source_entries >= 0);
