FROM node:22.23.1-trixie-slim AS x11-helper-build

RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 install -y --no-install-recommends gcc libc6-dev libx11-dev \
    && rm -rf /var/lib/apt/lists/*
COPY deploy/linux-desktop/set-window-decorations.c /tmp/set-window-decorations.c
RUN gcc -O2 -Wall -Wextra -o /usr/local/bin/dots-set-window-decorations /tmp/set-window-decorations.c -lX11

FROM node:22.23.1-trixie-slim AS desktop

ARG DEBIAN_FRONTEND=noninteractive

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    HOME=/workspace/.desktop-home \
    DISPLAY=:1 \
    COKE_DESKTOP_RESOLUTION=1440x900 \
    COKE_DESKTOP_START_URL=about:blank

ARG http_proxy
ARG https_proxy
ARG npm_config_proxy

RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 update \
    && for attempt in 1 2 3 4 5; do \
      apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 install -y --no-install-recommends \
        ca-certificates chromium curl dbus-x11 fonts-dejavu-core fonts-noto-cjk locales \
        novnc scrot tini util-linux websockify x11-utils x11vnc xdotool xfce4 xfce4-terminal xvfb \
      && break; \
      if [ "$attempt" -eq 5 ]; then exit 1; fi; \
      sleep 2; \
    done \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

# The package installation layer does not depend on resolution; set the final
# 4:3 display after it so the expensive desktop dependency layer stays reusable.
ENV COKE_DESKTOP_RESOLUTION=1440x1080

RUN apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 update \
    && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=180 -o Acquire::https::Timeout=180 install -y --no-install-recommends feh tint2 \
    && rm -rf /var/lib/apt/lists/*

RUN install -d -o node -g node "$HOME" /workspace /opt/coke-dots /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix

# Ship the upstream DeepSeek Harness CLI in the Debian computer. Pi and the
# TypeScript Harness client are installed from this repository's lockfile.
RUN npm_config_proxy="${npm_config_proxy:-${https_proxy:-${http_proxy:-}}}" npm install --global --omit=dev --no-audit --no-fund @deepseek-ai/dsh@0.2.0-rc.2 \
    && test -x /usr/local/bin/dsh
COPY --from=x11-helper-build /usr/local/bin/dots-set-window-decorations /usr/local/bin/dots-set-window-decorations

WORKDIR /opt/coke-dots
COPY package.json package-lock.json ./
RUN npm_config_proxy="${npm_config_proxy:-${https_proxy:-${http_proxy:-}}}" npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
RUN node --input-type=module -e "await import('@mariozechner/pi-coding-agent'); await import('@deepseek-ai/dsh-sdk-client')"

COPY --chmod=0755 deploy/linux-desktop/start-desktop.sh /usr/local/bin/start-dots-desktop
COPY --chmod=0644 deploy/linux-desktop/computer-worker.mjs /opt/coke-dots/computer-worker.mjs
COPY --chmod=0644 deploy/linux-desktop/renderer-health.mjs /opt/coke-dots/renderer-health.mjs
COPY --chmod=0644 src/shared/public-web-policy.mjs /opt/coke-dots/public-web-policy.mjs
COPY --chmod=0644 src/server/computer-home.mjs /opt/coke-dots/computer-home.mjs
COPY --chmod=0644 deploy/linux-desktop/agent-runtime.mjs /opt/coke-dots/agent-runtime.mjs
COPY --chmod=0644 deploy/linux-desktop/cloud-kernel-adapter.mjs /opt/coke-dots/cloud-kernel-adapter.mjs
COPY --chmod=0644 deploy/linux-desktop/coral-wallpaper.svg /opt/coke-dots/coral-wallpaper.svg
COPY --chmod=0644 deploy/linux-desktop/dots-file-manager.desktop /opt/coke-dots/dots-file-manager.desktop
RUN install -d -o node -g node -m 0755 /opt/coke-dots/icons
COPY --chmod=0644 src/web/assets/dots-files.png /opt/coke-dots/icons/dots-files.png
RUN install -d -o node -g node -m 0755 /opt/coke-dots/chrome-theme
COPY --chmod=0644 deploy/linux-desktop/chrome-theme/manifest.json /opt/coke-dots/chrome-theme/manifest.json

ARG COKE_DOTS_GIT_REVISION=unknown
LABEL org.opencontainers.image.revision=$COKE_DOTS_GIT_REVISION

USER 1000:1000
WORKDIR /workspace

EXPOSE 6080 8082 8083
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 CMD curl --fail --silent http://127.0.0.1:8082/readyz >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-dots-desktop"]
