ARG OCI_SOURCE
ARG OCI_VERSION
ARG OCI_REVISION

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS first-party-node
ARG OCI_SOURCE
ARG OCI_VERSION
ARG OCI_REVISION
LABEL org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}"
COPY LICENSE NOTICE /usr/share/doc/osinara/

FROM first-party-node AS dependencies
WORKDIR /app
# Eve and the Workflow Postgres world are our fork in vendor/, installed as copies (.npmrc).
COPY package.json package-lock.json .npmrc ./
COPY vendor ./vendor
COPY scripts/install-google-workspace-cli.ts ./scripts/install-google-workspace-cli.ts
RUN npm ci --ignore-scripts \
    && npm run install:gws

FROM dependencies AS build
COPY . .
RUN npm run typecheck && npm run lint && npm run build && npm run build:runtime

# Release-only artifact stage: output is one SEA executable, never a deployable container image.
FROM build AS installer-cli-build
ARG INSTALLATION_ARCHIVE_SHA256
ARG INSTALLATION_RELEASE_VERSION
RUN bash scripts/provider-installer/build-provider-installer-cli.sh \
    /tmp/osinara-linux-x64 "$INSTALLATION_RELEASE_VERSION" "$INSTALLATION_ARCHIVE_SHA256"

FROM scratch AS installer-cli-artifact
COPY --from=installer-cli-build /tmp/osinara-linux-x64 /osinara-linux-x64

FROM dependencies AS test
RUN apt-get update \
    && apt-get install --no-install-recommends --yes jq \
    && rm -rf /var/lib/apt/lists/*
COPY stress/telegram-conversation/package.json stress/telegram-conversation/package-lock.json ./stress/telegram-conversation/
RUN npm ci --ignore-scripts --prefix stress/telegram-conversation
COPY . .
CMD ["npm", "test"]

# Runtime images install only production packages; build tooling and TypeScript stay behind.
FROM first-party-node AS production-dependencies
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
COPY vendor ./vendor
COPY scripts/install-google-workspace-cli.ts ./scripts/install-google-workspace-cli.ts
RUN npm ci --omit=dev --ignore-scripts \
    && npm run install:gws

FROM first-party-node AS sandbox-runtime
COPY infra/certificates/russian-trusted-root-ca.crt /usr/local/share/ca-certificates/russian-trusted-root-ca.crt
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
      build-essential \
      ca-certificates \
      curl \
      fonts-liberation \
      findutils \
      grep \
      git \
      iptables \
      jq \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-xcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      poppler-utils \
      python3 \
      python3-pip \
      python3-venv \
      ripgrep \
      unzip \
      xdg-utils \
      zip \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# The browser stack ships in the image: the skill used to make the model install agent-browser
# and download Chrome (480 MB) into every tools workspace in the middle of a turn, one copy per
# family member and a version drift between them. Chrome for Testing matches the agent-browser
# release; Lightpanda is the light engine for reading (`--engine lightpanda`, no screenshots).
# Use the tagged Lightpanda release: nightly assets are replaced in place and invalidate the
# pinned checksum. agent-browser 0.36.0 was smoke-tested with 0.4.0 (open, title and snapshot).
ARG AGENT_BROWSER_VERSION=0.36.0
ARG CHROME_FOR_TESTING_VERSION=152.0.7977.82
ARG LIGHTPANDA_VERSION=0.4.0
ARG LIGHTPANDA_SHA256=bfcf9bd7e80939b87232aa114a49d8f397f51af0c2632d9fc58d4a6d4386624f
RUN npm install --global --no-fund --no-audit "agent-browser@${AGENT_BROWSER_VERSION}" \
    && curl -fsSL -o /tmp/chrome-linux64.zip \
      "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_FOR_TESTING_VERSION}/linux64/chrome-linux64.zip" \
    && printf '%s  %s\n' 0704631fb3e4f741092e08f55272f90abc3e307f991f05f332924364415b02e0 /tmp/chrome-linux64.zip | sha256sum --check - \
    && mkdir -p /opt/chrome \
    && unzip -q /tmp/chrome-linux64.zip -d /opt/chrome \
    && rm -f /tmp/chrome-linux64.zip \
    && curl -fsSL -o /usr/local/bin/lightpanda \
      "https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-x86_64-linux" \
    && printf '%s  %s\n' "${LIGHTPANDA_SHA256}" /usr/local/bin/lightpanda | sha256sum --check - \
    && chmod 0755 /usr/local/bin/lightpanda \
    && /usr/local/bin/lightpanda version \
    && ln -s /opt/chrome/chrome-linux64/chrome /usr/bin/google-chrome \
    && /opt/chrome/chrome-linux64/chrome --version \
    && agent-browser --version
# No AGENT_BROWSER_EXECUTABLE_PATH: agent-browser applies it to every engine, so Lightpanda would
# launch Chrome. The system symlink is where agent-browser looks for Chrome on its own.
COPY --from=production-dependencies \
  /app/node_modules/@googleworkspace/cli/bin/gws \
  /opt/osinara/gws
WORKDIR /workspace
CMD ["sleep", "infinity"]

FROM first-party-node AS sandbox-runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/.runtime/services/sandbox-runner/main.js ./.runtime/services/sandbox-runner/main.js
CMD ["node", ".runtime/services/sandbox-runner/main.js"]

FROM first-party-node AS sandbox-egress-proxy
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/.runtime/services/sandbox-egress-proxy/main.js ./.runtime/services/sandbox-egress-proxy/main.js
USER node
CMD ["node", ".runtime/services/sandbox-egress-proxy/main.js"]

# BERTA ships safetensors only, so TEI ran it through candle. The same weights exported to ONNX
# fp32 answer a query a quarter faster on one core (80 → 61 ms on the load stand, 4 October 2026,
# vectors equal to 1e-4) and the embedder stops reaching the Hugging Face hub at start. Model
# revision and the whole export environment are pinned so a rebuild exports the same bytes.
FROM python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016 AS berta-onnx-export
ENV PIP_NO_CACHE_DIR=1 HF_HOME=/hf HF_HUB_DISABLE_TELEMETRY=1
# Every package of the export environment is pinned, transitive ones included, so a rebuild
# after a cache reset resolves the same set.
RUN pip install --no-deps --extra-index-url https://download.pytorch.org/whl/cpu \
      torch==2.14.1+cpu onnx==1.23.1 onnxruntime==1.30.0 optimum==2.1.0 optimum-onnx==0.1.0 \
      transformers==4.57.6 huggingface_hub==0.36.2 tokenizers==0.22.2 safetensors==0.8.0 \
      numpy==2.5.3 certifi==2026.7.22 charset-normalizer==3.5.2 filelock==4.0.10 \
      flatbuffers==25.12.19 fsspec==2026.9.0 hf-xet==1.6.0 idna==3.20 Jinja2==3.1.6 \
      MarkupSafe==3.0.4 ml_dtypes==0.6.0 mpmath==1.3.0 networkx==3.7 packaging==26.3 \
      protobuf==7.36.2 PyYAML==6.0.3 regex==2026.9.29 requests==2.34.2 setuptools==84.0.0 \
      sympy==1.14.0 tqdm==4.70.1 typing_extensions==4.16.0 urllib3==2.8.0 \
    && pip check
RUN hf download sergeyzh/BERTA --revision 914c8c8aed14042ed890fc2c662d5e9e66b2faa7 \
      --local-dir /models/berta-source \
    && HF_HUB_OFFLINE=1 optimum-cli export onnx --model /models/berta-source \
      --task feature-extraction /models/berta-onnx \
    && mkdir /models/berta-onnx/onnx \
    && mv /models/berta-onnx/model.onnx /models/berta-onnx/onnx/model.onnx \
    && rm -rf /models/berta-source /hf

FROM ghcr.io/huggingface/text-embeddings-inference:cpu-1.9@sha256:ad950d30878eceb72aaf32024d26fa2b1d04a75304fa0b4776b49aa1941fea07 AS memory-embedding
ARG OCI_SOURCE
ARG OCI_VERSION
ARG OCI_REVISION
LABEL org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}"
COPY --from=berta-onnx-export /models/berta-onnx /models/berta-onnx
# The router takes the model and pooling from these; `onnx/model.onnx` selects its ONNX backend.
# The agent compares the `model` of every embedding answer with MEMORY_EMBEDDING_MODEL
# (agent/lib/memory-config.ts) and treats another name as a foreign embedder, so the served
# name stays the hub id (the load stand lost memory on every turn without it, 4 October 2026).
ENV MODEL_ID=/models/berta-onnx SERVED_MODEL_NAME=sergeyzh/BERTA POOLING=mean HF_HUB_OFFLINE=1

FROM first-party-node AS runtime
RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/.eve ./.eve
COPY --from=build /app/.runtime ./.runtime
COPY --from=build /app/services/skill-lab/.output ./services/skill-lab/.output
# Eve `start` serves `.output` but still resolves authored modules from this tree.
COPY --from=build /app/agent ./agent
COPY --from=build /app/config ./config
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./package.json
COPY scripts/docker-entrypoint.sh /usr/local/bin/osinara-entrypoint
RUN chmod +x /usr/local/bin/osinara-entrypoint
EXPOSE 3000
ENTRYPOINT ["osinara-entrypoint"]

FROM nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de AS edge
ARG OCI_SOURCE
ARG OCI_VERSION
ARG OCI_REVISION
LABEL org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}"
COPY LICENSE NOTICE /usr/share/doc/osinara/
COPY infra/nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
