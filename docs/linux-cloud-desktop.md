# Linux cloud computer prototype

This is an additive computer backend for Coke Dots. It provisions one Debian desktop namespace, Deployment, Service, Secret, and persistent workspace volume for each Dots workspace. The existing local-browser backend remains available by default.

The initial desktop page follows the visible flow in John Aspinall's [Dots cloud-computer video](../research/cloud-computer-observations.md): at 04:44 the video shows a Dot welcome page inside a centered browser window, on a coral 4:3 desktop with a three-icon dock and an explicit “Take over” state; around 04:50 the same page remains open after the owner changes to the user. The Linux Worker injects the shared, tenant-named welcome page into Chromium before the first screenshot. The Debian shell hides XFCE's panels, paints the observed coral wallpaper, positions Chromium at the measured relative inset, and shows a small dock. The video does not reveal the source screen resolution or CSS pixels, so these are measured ratios rather than a claim of exact pixel parity.

## Debian evidence

OpenAI's [computer and apps documentation](https://learn.chatgpt.com/docs/dots/computers-and-apps) confirms that Dots has a persistent cloud computer and browser and supports taking over and returning control. OpenAI does not identify the Linux distribution. A user report in the [OpenAI Developer Community](https://community.openai.com/t/docker-container-support-for-dots-working-in-the-cloud-computers/1402440) describes a Dots cloud environment running Debian 13 x64; [Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/geekbench-7-results-suggest-openais-dots-agent-runs-on-nine-core-amd-epyc-vms-with-nearly-10gb-of-memory-newest-runs-score-about-six-times-meta-muse-in-multi-core) also reports Debian in post-launch benchmark runs and Ubuntu in a pre-launch run. Coke Dots uses Debian 13 Trixie as an evidence-based prototype choice, not as an officially confirmed OpenAI implementation detail.

## Build and local K3D run

Build the image from the repository root and make it available to the local K3D cluster:

```sh
docker build -f deploy/linux-desktop/Dockerfile -t coke-dots-linux-desktop:dev .
k3d image import coke-dots-linux-desktop:dev -c <cluster-name>
```

Configure the host service before starting it:

```sh
DOTS_COMPUTER_BACKEND=linux-desktop
DOTS_LINUX_DESKTOP_TOKEN_SECRET=<random secret of at least 32 characters>
DOTS_LINUX_DESKTOP_IMAGE=coke-dots-linux-desktop:dev
DOTS_LINUX_DESKTOP_CONTROL_NAMESPACE=<namespace containing the Coke Dots service>
```

The connector applies only the tenant namespace and desktop resources, waits for the desktop Deployment, then creates loopback-only `kubectl port-forward` connections. For an in-cluster Coke Dots service, it uses the desktop Service DNS name instead. Keep the token secret in a local environment file or OS credential store; do not commit it.

The Service exposes noVNC (6080), the restricted browser Worker (8082), and the Agent runtime (8083). Chromium CDP (9222) is not exposed by the Service and listens on loopback inside the Pod. The Worker offers only navigation, click, type, key, screenshot, state, and control operations. Human input is enabled only after takeover.

## Agent kernel adapter contract

`DOTS_AGENT_KERNELS_JSON` maps enabled engine names (`claude`, `pi`, `dsh`) to an operator-installed executable and argument list. The runtime invokes the executable with `shell: false`, in `/workspace/tasks/<taskId>`, and sends one JSON object on stdin containing `engine`, `prompt`, `cwd`, `workspace`, `taskId`, `sessionId`, and a scoped browser Worker endpoint/token. The executable must write one JSON decision to stdout, with a supported task status and a non-empty `message`. Adapter stderr is discarded. The runtime credential is filtered from the child process environment.

This is an adapter protocol, not a claim that Pi, Claude Code, or DeepSeek Harness is preinstalled or configured. Each command must be installed in the image and reviewed by the operator. Add an engine only after its adapter contract and credentials have been tested.

The runtime queues tasks for each desktop so two Agent processes cannot control the same Chromium instance at once. Taking over the computer asks the active process to stop and stores a waiting decision; after returning control, the user can ask the Dot to continue. Task records live in the Coke Dots SQLite store; the desktop PVC preserves files. If the Coke Dots service restarts during a cloud Agent run, the task row is requeued without changing its execution identity and the Debian runtime keeps the adapter running after the HTTP connection closes. It atomically saves the completed decision on that tenant's PVC under a hash of the task ID and replays it when the restarted worker dispatches the same execution. A changed execution identity or prompt produces a new run, so a user redirection and a later recurring run cannot receive an old result. Explicit Activity pause and stop actions are sent to the remote runtime and still interrupt active or queued work.

This recovery covers Coke Dots control-plane restarts while the desktop Pod remains available. It does not checkpoint a child process or resume an adapter after its own Pod is restarted mid-run; in that case the persisted workspace remains available and the task is retried from the saved Agent session when one exists.

## Verification and current limits

`npm run test:e2e` runs the existing Chrome UI flow and a cloud-computer browser E2E against isolated mock tenant runtimes. The cloud E2E verifies the screenshot route, authenticated noVNC HTTP and WebSocket proxy, takeover and return, browser navigation/click/type requests, remote Agent dispatch, and tenant token separation.

For the real local K3D image and noVNC flow, first build/import the image, then run `npm run test:e2e:k3d`. Set `DOTS_K3D_CLUSTER` to an existing local cluster name when it is not `tp1121-sandbox-dev`; the script refuses a different active kubectl context. It signs in a disposable test tenant, provisions that tenant's product-prefixed namespace, and deletes only that namespace in its cleanup path. It reads `/etc/os-release` and checks Debian 13 Trixie and Node.js 22 inside the running Pod, verifies that the welcome page uses the tenant's Dot name (“Welcome back, Roger” in the source-frame fixture), renders a nonblank 1440x1080 screenshot with the coral wallpaper and Chromium theme, connects the noVNC canvas/WebSocket, and performs browser navigation/click/type plus takeover and hand-back. It also calls the live Agent runtime through its tenant token, checks that the child adapter cannot read the runtime token, and verifies an Agent-created file survives Pod recreation on the tenant PVC. The cluster must have enough memory for an XFCE desktop plus Chromium. The local K3D harness explicitly uses Chromium's `--no-sandbox` because this cluster disallows the Chromium namespace sandbox; the deployed runtime defaults to sandbox enabled and requires an appropriate Kubernetes kernel/security profile.

The mock E2E does not prove a real K3D Pod or Debian image starts. Build and K3D checks require Docker to be running. This local prototype is bound to `127.0.0.1`; it is not exposed to the Internet. For production multi-user hosting, the control plane, OAuth session handling, Kubernetes RBAC, NetworkPolicy behavior, per-tenant resource quotas, secret rotation, and cleanup lifecycle need deployment-specific review. The current NetworkPolicy permits desktop outbound HTTP and HTTPS for browser and Agent tasks.
