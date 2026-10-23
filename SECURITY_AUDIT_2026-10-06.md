# Security-аудит Osinara — 6 октября 2026

Полный аудит кодовой базы на HEAD `358b600` (Release 1.8.30), два прохода:
первый — ingress/авторизация, память/SQL, tool policy/sandbox; второй — зоны, не покрытые
первым (supply chain обновлений, OAuth/AEAD, расписания, browser-инструменты, skill-lab,
новый sandbox-код 1.8.29–1.8.30, сетевая топология Docker).

## Вердикт

**Критичных и высоких уязвимостей в коде приложения не найдено.** Все находки первого
прохода закрыты коммитами 1.8.29–1.8.30. Открытыми остаются: зависимость `undici`
(high, фикса нет), plaintext личной памяти на диске, отсутствие RLS и два новых пункта
(раздел «Открытые находки»).

---

## Открытые находки

### 🔴 Зависимости — единственный actionable high

`npm audit`: 4 high, 5 moderate из 230 prod-зависимостей.

| Пакет | Severity | Фикс | Контекст |
|---|---|---|---|
| `undici` (10 advisories: response splitting, TLS bypass в BalancedPool, cookie disclosure, DoS) | high | **нет** — пиннатся `@ai-sdk/*` | Основной HTTP-стек; агент ходит к произвольным хостам через web_fetch/browser |
| `brace-expansion` (ReDoS) | high | `npm audit fix` | |
| `js-yaml` (CPU DoS) | high | `npm audit fix` | |
| `@grpc/grpc-js` (auth bypass в отдельных конфигурациях) | high | `npm audit fix` | |
| `vitest`/`@vitest/mocker` (path traversal) | moderate | `npm audit fix --force` | dev-only |

### 🟡 N-1. MEDIUM (латентно): `dangerouslyAllowFullInternetAccess` в локальном just-bash бэкенде

- **Где:** `vendor/eve/dist/src/execution/sandbox/bindings/just-bash-runtime.js`, `createBashSandbox`:
  `network: { dangerouslyAllowFullInternetAccess: true }`. Потребитель —
  `services/skill-lab/agent/sandbox.ts` (`justbash({ autoInstall: false })` без filesystem/network опций).
- **Сейчас не эксплуатируется:** в лаборатории `bash`/`web_fetch`/`web_search` перекрыты
  `disableTool()`, внешние инструменты симулируются frozen fixtures
  (`services/skill-lab/agent/lib/scenario.ts`), продакшен-исполнителей нет.
- **Риск:** инвариант неявный. Если в лаборатории когда-нибудь включат выполняющий инструмент,
  модельный сценарий получит сетевой доступ из **контейнера агента** (процесс спавнится
  `runSkillLab` внутри agent-контейнера): внутреннюю app-network (workflow-роут
  `agent:3000` без секрета, TEI embedding, postgres по TCP) и прямой интернет в обход всего
  egress-стека (firewall, proxy, SSRF-политика). `begin_trial` не входит в MUTATING_ACTIONS
  HITL-набора (`agent/lib/tools/manage_skill.ts:52`), т.е. владелец пробу не утверждает.
- **Рекомендация:** сетевая политика в опциях лабораторного sandbox либо тест, фиксирующий
  `disableTool()` для bash/web_fetch/web_search и fixture-only исполнение.

### 🟡 N-2. INFO→MEDIUM: workflow flow-роут без аутентификации на `agent:3000`

- `/.well-known/workflow/v1/flow` — «checks header shape but no secret» (комментарий
  `infra/nginx.conf`). Осознанный network-position trust: маршрут достижим только из
  app-network (доверенные сервисы), наружу и из сандбоксов недостижим.
- В связке с N-1 — цель для будущих внутренних компрометаций. Кандидат на распространение
  `AGENT_INTERNAL_TOKEN`.

### 🟡 Память в plaintext на диске

- `memory_items` (включая `sensitivity='sensitive'`) хранится без шифрования; зашифрованы
  только Google-токены (AES-256-GCM). Компромисс тома/БД раскрывает личные факты.
- Частичные компенсации: `memory-content-policy.ts` fail-fast запрещает сохранять
  ключи/карты/OTP/CVV; sensitive исключён из profile-проекций.

### 🟡 RLS отсутствует, смягчено DML-only ролью

- По-строчная изоляция живёт только в SQL-предикатах приложения. С 1.8.30 (`b640f72`) агент
  ходит как `osinara_app` (NOSUPERUSER, NOBYPASSRLS, revoke CREATE на public, revoke
  `schema_migrations`) — будущий запрос без предиката всё равно не выйдет за DML, но
  DB-бэкстопа по строкам нет.

### ℹ️ Прочее (info)

- `sandbox-runner` API без auth — только internal network + `docker.sock`; все входы
  строго zod-валидированы, пути конфайнены, shell-аргументы экранированы (инъекция через
  имена файлов была найдена и закрыта ранее).
- Provider-native `web_search` во внешних группах: revocation с лагом в один model step
  (задокументировано); на DeepSeek поиск идёт через локальный executor с live-перепроверкой.
- Общий `sandbox-egress` мост: латеральные соединения между сандбоксами закрыты firewall
  в netns каждого контейнера (OUTPUT только proxy:3128, INPUT только established);
  остаётся общий L2, но атаки на пиры дропаются.
- `releaseStaleLeases` предполагает одну реплику агента (`--scale agent=2` погасит живые
  аренды — availability, не обход exactly-once).
- Тестовый пароль `osinara-test-only` в `compose.test.yaml` (CI-only, портов наружу нет).
- DNS egress-прокси к 1.1.1.1 поверх UDP — наблюдаемость запросов, не уязвимость для данной
  threat model.

---

## Закрыто между проходами (коммиты 1.8.29–1.8.30)

| Находка первого аудита | Фикс |
|---|---|
| Один `TELEGRAM_WEBHOOK_SECRET_TOKEN` на три контура | `AGENT_INTERNAL_TOKEN` (`b640f72`): timing-safe, конфиг требует ≥32 символа и отличия от webhook-секрета, без fallback |
| Слабая валидация webhook-секрета (`min(1)`) | `secretTokenSchema = min(32).max(256).regex([A-Za-z0-9_-])` (`agent/config.ts:124`) |
| Латеральное движение между сандбоксами в общем egress-мосте | Firewall в netns (`docker-sandbox-hardening.ts`): OUTPUT DROP + только proxy:3128, INPUT только established, start-barrier на каждый старт контейнера |
| Регистрация произвольного chat-id без доказательства владения | `getChatMember` admin-proof в момент исполнения, проверяемый id — верифицированный session actor (`b41de34`) |
| Нет DB least privilege | Роль `osinara_app` DML-only; owner-коннект остался только у migrate |
| NFKC после `basename()` — fullwidth-сепараторы в именах вложений | NFKC теперь до basename (`attachment-policy.ts`) |
| Бессрочное хранение raw `telegram_ingress_updates` | `telegram-ingress-retention.ts` + конфиг TTL |
| TOCTOU staging-каталога при загрузке файлов в сандбокс | Передача через stdin/stdout процесса, read-only root контейнера (`docker-sandbox-transfer.ts`) |
| DevTools-порт залогиненного браузера доступен Bash модели | Companion-контейнер браузера, состояние сессии вынесено из tools-volume (`docker-sandbox-browser.ts`) |
| Исчерпание диска модельным Bash | Квота 2 ГБ на workspace + порог свободного места 3 ГБ, fail-closed при неизмеримости |

---

## Подтверждено защищённым (оба прохода)

### Edge и ingress
- Nginx: три публичных маршрута (webhook 1 МБ, GET-only OAuth callback, health), остальное 404;
  edge в production только на `127.0.0.1:8082`.
- Webhook: timing-safe сравнение до чтения body; drain/sweep наружу не торчат, оба на
  `AGENT_INTERNAL_TOKEN` (timing-safe).
- Exactly-once: PK `update_id` + `ON CONFLICT`, барьеры dispatch/transcription,
  `FOR UPDATE SKIP LOCKED`, tombstones, heartbeat-аренды.

### Авторизация
- Auth/scopes только из verified update + live PostgreSQL; внешняя группа всегда `["group"]`.
- Личная/семейная память недостижима из внешней группы ни через один из 13 memory-инструментов,
  ни через FTS/вектора (CTE `authorized` выше всех веток retrieval), нити, профиль, экспорт;
  TOCTOU-барьеры live-реавторизации после каждого чтения.
- HITL: атомарный claim по `expected_telegram_user_id`, input-hash в evidence, повторный вывод
  owner-role из БД на исполнении; таймаут-отмена через 5 минут.
- Tool surface: fail-closed — неизвестная запись allowlist обнуляет весь набор; каждая выдача
  инструмента перепроверяет live-policy `FOR SHARE`; `bash`/`agent`/`web_fetch`/`web_search`
  перекрыты отказами с тестами.
- Расписания: полный SQL-предикат (scope, chat_id, thread, membership, тип группы, owner-role
  для group-scope) как точка линейной авторизации прямо перед Telegram side effects.

### Файловая система и сандбоксы
- Внешняя группа: канонический путь с заменой model-path до Eve, точный prefix-match корня
  `/workspace/group`, запрет symlink-компонентов; app-side I/O через `O_NOFOLLOW` +
  `/proc/self/fd` (закрывает check/use гонку).
- Restricted-контейнеры: `NetworkMode: none`, `CapDrop ALL`, tmpfs `$HOME`, `/tmp` noexec.
- `import_telegram_attachment`: allowlist расширений после NFKC, binary-детект по magic bytes,
  strict UTF-8 без NUL, лимиты 20 МБ.
- Disk-quota: `du`-измерение с TTL-кэшем, fail-closed, cleanup-команды — строгий regex без
  метасимволов; системные утилиты по абсолютным путям из read-only root.

### Сеть
- Egress-proxy: DNS-резолв на прокси через 1.1.1.1 с пином IP (нет DNS rebinding), полный
  blocklist private/reserved (включая IPv4-mapped IPv6, NAT64, Teredo, 6to4), только порты
  80/443, фильтрация hop-by-hop, redirect-хопы перепроверяются на app-слое и прокси.
- Сандбоксы не достают до `agent:3000`/postgres; egress-proxy не транмплин (private IP и
  порты ≠80/443 блокируются). Сетевая топология: app-network / sandbox-control / sandbox-egress
  (internal) разведены; единственный published-порт — edge на loopback.

### Supply chain
- Установщик: SEA CLI с зашитыми version+SHA-256; gws/Chrome/Lightpanda — checksum-pinned;
  base-образы по digest.
- Обновления: immutable-релизы, semver без downgrade, digest-pinned образы, compose сверен по
  SHA-256, tag→commit биндинг, манифест обязан совпасть с HITL-одобренными байтами (TOCTOU),
  resolved-compose — точный mount-allowlist, запрет privileged/host/build/devices.

### Криптография и секреты
- Bootstrap-код: 32 байта, SHA-256 в БД, TTL 15 мин, 5 попыток, constant-time.
- Приглашения: 192-битные коды + HMAC для replay-стабильности, секрет ≥32.
- OAuth state: 256 бит, хэш в БД, атомарное одноразовое погашение, supersede, TTL.
- Токены Google: AES-256-GCM, случайный 96-бит nonce, строгий 32-байтный base64 ключ, auth tag.
- Секреты: в git никогда не попадали (проверена история), compose только `${VAR:?required}`,
  `redactSecrets` перед логами и моделью; lab-наследник получает только `MODEL_API_KEY`
  и собственный токен.

### Browser и skill-lab
- Browser gate: решения кодом, не моделью; Enter не входит в SAFE_KEYS (обход формы нажатием
  Enter закрыт), после ввода данных гейтится любой клик, confirm — durable claim с anti-replay
  и stale-проверками; браузер только для участников семьи (personal/family).
- Lavka-скрипт: данные модели/пользователя доходят до страницы только JSON-литералами,
  origin-guard от навигации вкладки.
- Skill-lab: bash/web_fetch/web_search отключены, внешние инструменты — frozen fixtures,
  публикация навыков — HITL владельца; `---javascript` frontmatter отвергается Eve-форком.

### Прочее
- SQL полностью параметризован (включая FTS и векторные литералы); интерполяции в SQL — только
  из констант модуля.
- Telegram-вывод: allowlist-санитайзер с protected code-блоками, plain-путь без parse_mode,
  `<telegram-split>` действует только на текст модели с потолком 5 сообщений.
- `eval`/`new Function` — только в тестах; dangerous-паттерн grep чист; `root-file-store`
  (модель-конфиг): фиксированные argv, O_NOFOLLOW/O_EXCL, ownership/realpath-проверки,
  точный allowlist путей.
- Kill-stray: absolute-path allowlist из read-only root, изолированный python (`-I`).

---

## Рекомендованный порядок действий

1. `npm audit fix` (brace-expansion, js-yaml, @grpc/grpc-js); завести трекинг `undici` до
   фикса в `@ai-sdk/*`.
2. Закрыть N-1 превентивно: network-политика лабораторного sandbox или тест на
   `disableTool()` — одна строка/один тест против будущего обхода egress-стека.
3. `AGENT_INTERNAL_TOKEN` на workflow flow-роут (N-2) при следующем патче vendor/eve.
4. Шифрование памяти at-rest и RLS — крупные задачи, отдельным scope (persisted-контракты
   не трогать без явного scope задачи).
