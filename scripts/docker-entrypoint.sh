#!/bin/sh
set -eu

# Fail before migrations or network listeners when required runtime configuration is absent.
for name in DATABASE_URL INVITATION_SIGNING_SECRET MODEL_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET_TOKEN TELEGRAM_BOT_USERNAME; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    printf '%s\n' "AGENT_REQUIRED_CONFIG_MISSING: Не задана обязательная настройка $name" >&2
    exit 1
  fi
done

# Invitation codes require a dedicated high-entropy signing secret for replay-safe derivation.
INVITATION_SIGNING_SECRET_MIN_LENGTH=32
if [ "${#INVITATION_SIGNING_SECRET}" -lt "$INVITATION_SIGNING_SECRET_MIN_LENGTH" ]; then
  printf '%s\n' "AGENT_INVITATION_CONFIG_MISSING: INVITATION_SIGNING_SECRET должен содержать минимум 32 символа" >&2
  exit 1
fi

# Validate model IDs and context metadata before Eve opens a listener or accepts durable work.
node .runtime/scripts/validate-model-provider-config.js

# Sandbox templates are prepared by a one-shot step, then the built server is this container's
# process: the npm wrapper and the `eve start` parent only supervised it and held ~430 MB.
# The watchdog replaces the five-minute health wait of `eve start`: started right before `exec`,
# its parent becomes the server, which gets SIGTERM if health never answers, so Docker restarts.
start_server() {
  node .runtime/scripts/prewarm-sandboxes.js
  export HOST=0.0.0.0 NITRO_HOST=0.0.0.0 PORT=3000 NITRO_PORT=3000
  node .runtime/scripts/startup-watchdog.js &
  # Bounded heap: by default V8 may grow to ~2.2 GB on this host and kept ~1 GB of garbage under
  # load; at 512 MB the load run held 200 families at the same speed (AGENT_PROCESS_MEMORY).
  exec node --max-old-space-size=512 .output/server/index.mjs
}

# A compose run command is an explicit operator action and must terminate normally.
if [ "$#" -eq 1 ] && [ "$1" = "start-after-migration" ]; then
  start_server
fi
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# Production images contain the emitted migration runner, not TypeScript source files.
node .runtime/scripts/migrate.js
start_server
