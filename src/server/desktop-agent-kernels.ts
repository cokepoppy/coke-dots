export type DesktopAgentEngine = 'pi' | 'dsh';

export interface DesktopAgentKernel {
  command: string;
  args: string[];
}

export type DesktopAgentKernels = Partial<Record<DesktopAgentEngine, DesktopAgentKernel>>;

const supportedEngines = new Set<DesktopAgentEngine>(['pi', 'dsh']);

/**
 * Resolve the kernel map shared by the host control plane and each tenant desktop.
 * Pi is the default cloud kernel when Linux desktops and Pi are enabled. An explicit
 * JSON object, including `{}`, remains the operator override.
 */
export function desktopAgentKernels(environment: NodeJS.ProcessEnv = process.env): DesktopAgentKernels {
  if (environment.DOTS_COMPUTER_BACKEND !== 'linux-desktop') return {};

  const configured = environment.DOTS_AGENT_KERNELS_JSON?.trim();
  if (configured) {
    try {
      const parsed: unknown = JSON.parse(configured);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const kernels: DesktopAgentKernels = {};
      for (const [engine, value] of Object.entries(parsed)) {
        if (!supportedEngines.has(engine as DesktopAgentEngine) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        const candidate = value as { command?: unknown; args?: unknown };
        if (typeof candidate.command !== 'string' || !candidate.command.trim()
          || !Array.isArray(candidate.args) || candidate.args.some(argument => typeof argument !== 'string')) continue;
        kernels[engine as DesktopAgentEngine] = { command: candidate.command, args: candidate.args };
      }
      return kernels;
    } catch {
      return {};
    }
  }

  if (environment.DOTS_PI_ENABLED === '1') {
    return { pi: { command: 'node', args: ['/opt/coke-dots/cloud-kernel-adapter.mjs'] } };
  }
  return {};
}
