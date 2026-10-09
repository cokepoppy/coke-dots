FROM node:22.23.1-trixie-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG COKE_DOTS_GIT_REVISION=unknown

LABEL org.opencontainers.image.revision=$COKE_DOTS_GIT_REVISION

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    HOME=/workspace/.desktop-home \
    DISPLAY=:1 \
    COKE_DESKTOP_RESOLUTION=1440x900 \
    COKE_DESKTOP_START_URL=https://example.com

RUN apt-get -o Acquire::Retries=5 update && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      ca-certificates chromium curl dbus-x11 fonts-dejavu-core fonts-noto-cjk locales \
      novnc scrot tini websockify x11-utils x11vnc xdotool xfce4 xfce4-terminal xvfb \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

RUN install -d -o node -g node /workspace /opt/coke-dots /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix

WORKDIR /opt/coke-dots
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY --chmod=0755 deploy/linux-desktop/start-desktop.sh /usr/local/bin/start-dots-desktop
COPY --chmod=0644 deploy/linux-desktop/computer-worker.mjs /opt/coke-dots/computer-worker.mjs
COPY --chmod=0644 deploy/linux-desktop/browser-context.mjs /opt/coke-dots/browser-context.mjs
COPY --chmod=0644 deploy/linux-desktop/agent-runtime.mjs /opt/coke-dots/agent-runtime.mjs

USER 1000:1000
WORKDIR /workspace

EXPOSE 6080 8082 8083
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 CMD curl --fail --silent http://127.0.0.1:8082/readyz >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-dots-desktop"]
