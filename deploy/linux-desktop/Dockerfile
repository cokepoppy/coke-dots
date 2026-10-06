FROM node:22.23.1-trixie-slim

ARG DEBIAN_FRONTEND=noninteractive

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    HOME=/workspace/.desktop-home \
    DISPLAY=:1 \
    COKE_DESKTOP_RESOLUTION=1440x900 \
    COKE_DESKTOP_START_URL=about:blank

ARG http_proxy
ARG https_proxy

RUN apt-get -o Acquire::Retries=5 update \
    && for attempt in 1 2 3 4 5; do \
      apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
        ca-certificates chromium curl dbus-x11 fonts-dejavu-core fonts-noto-cjk locales \
        novnc scrot tini websockify x11-utils x11vnc xdotool xfce4 xfce4-terminal xvfb \
      && break; \
      if [ "$attempt" -eq 5 ]; then exit 1; fi; \
      sleep 2; \
    done \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

# The package installation layer does not depend on resolution; set the final
# 4:3 display after it so the expensive desktop dependency layer stays reusable.
ENV COKE_DESKTOP_RESOLUTION=1440x1080

RUN apt-get -o Acquire::Retries=5 update \
    && apt-get -o Acquire::Retries=5 install -y --no-install-recommends feh tint2 \
    && rm -rf /var/lib/apt/lists/*

RUN install -d -o node -g node "$HOME" /workspace /opt/coke-dots /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix

WORKDIR /opt/coke-dots
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY --chmod=0755 deploy/linux-desktop/start-desktop.sh /usr/local/bin/start-dots-desktop
COPY --chmod=0644 deploy/linux-desktop/computer-worker.mjs /opt/coke-dots/computer-worker.mjs
COPY --chmod=0644 src/server/computer-home.mjs /opt/coke-dots/computer-home.mjs
COPY --chmod=0644 deploy/linux-desktop/agent-runtime.mjs /opt/coke-dots/agent-runtime.mjs
COPY --chmod=0644 deploy/linux-desktop/coral-wallpaper.svg /opt/coke-dots/coral-wallpaper.svg

USER 1000:1000
WORKDIR /workspace

EXPOSE 6080 8082 8083
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 CMD curl --fail --silent http://127.0.0.1:8082/readyz >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-dots-desktop"]
