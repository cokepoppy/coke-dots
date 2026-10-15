FROM node:22.23.1-trixie-slim

ARG TARGETARCH
ARG DWS_VERSION=1.0.64
ARG DWS_ARCHIVE_SHA256_AMD64=68fd68effdb05c4f7af5771dfc7bf6c10d97d219b3fb992dc99165b198fddb32
ARG DWS_ARCHIVE_SHA256_ARM64=351504a475b60c51a7b4abeb1a79f4e8de8b2ce1f06f97e0a5791a996bfe29a9

ENV NODE_ENV=production \
    DINGTALK_CONNECTOR_PORT=8789 \
    DINGTALK_CONNECTOR_STORAGE_ROOT=/var/lib/dws/profiles \
    DINGTALK_CONNECTOR_TMP_ROOT=/run/dws

RUN apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      ca-certificates curl tar \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o 10001 -g 10001 /opt/dingtalk-connector /var/lib/dws/profiles /run/dws

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) DWS_ARCH=amd64; DWS_ARCHIVE_SHA256="$DWS_ARCHIVE_SHA256_AMD64" ;; \
      arm64) DWS_ARCH=arm64; DWS_ARCHIVE_SHA256="$DWS_ARCHIVE_SHA256_ARM64" ;; \
      *) echo "Unsupported DWS target architecture: $TARGETARCH" >&2; exit 2 ;; \
    esac; \
    curl -fsSL "https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v${DWS_VERSION}/dws-linux-${DWS_ARCH}.tar.gz" -o /tmp/dws.tar.gz; \
    echo "$DWS_ARCHIVE_SHA256  /tmp/dws.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/dws.tar.gz -C /usr/local/bin ./dws; \
    chmod 0555 /usr/local/bin/dws; \
    rm -f /tmp/dws.tar.gz

COPY --chown=10001:10001 deploy/dingtalk-connector/gateway.mjs /opt/dingtalk-connector/gateway.mjs
COPY --chown=10001:10001 deploy/dingtalk-connector/lib/ /opt/dingtalk-connector/lib/

USER 10001:10001
WORKDIR /opt/dingtalk-connector

EXPOSE 8789
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 CMD node -e "fetch('http://127.0.0.1:8789/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/dingtalk-connector/gateway.mjs"]
