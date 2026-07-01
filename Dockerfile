FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:26-bookworm-slim AS runtime
WORKDIR /app

ARG KUBECTL_VERSION=v1.30.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) kubectl_arch=amd64 ;; \
    arm64) kubectl_arch=arm64 ;; \
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${kubectl_arch}/kubectl"; \
  chmod +x /usr/local/bin/kubectl; \
  kubectl version --client=true

ENV NODE_ENV=production \
    PORT=8787 \
    HOME=/data \
    XDG_CONFIG_HOME=/data/.config \
    XDG_DATA_HOME=/data/.local/share

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /data/.config /data/.local/share /data/.kube \
  && chown -R 10001:10001 /data

USER 10001:10001

VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD curl -fsS http://127.0.0.1:8787/api/healthz || exit 1

CMD ["node", "server/index.js"]
