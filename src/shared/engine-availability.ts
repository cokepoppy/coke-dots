import type { Engine, Snapshot } from './types.ts';

export function engineAvailabilityHint(
  state: Pick<Snapshot, 'availableEngines' | 'remoteEngines' | 'modelSettings'>,
  engine: Engine,
): string {
  const settings = state.modelSettings;
  if (settings.apiKeyStatus === 'unavailable') return '无法读取实例共享 API 密钥。请检查 K3D 集群连接和 Secret 权限。';
  if (settings.apiKeyStatus === 'missing' || !settings.hasKey || !settings.baseUrl || !settings.model) {
    return '实例共享模型 API 尚未完整配置。请检查模型地址、名称和 K3D Secret。';
  }
  if (state.availableEngines.includes(engine)) {
    return state.remoteEngines.includes(engine) ? '任务由 Dot 的云电脑运行。' : '任务由本机后台处理。';
  }
  if (state.remoteEngines.includes(engine)) return '云电脑已登记此 Agent 内核，但当前模型配置不可用。';
  return '实例共享 API 已保存；当前云电脑版本尚未注册 Pi Agent 适配器，请检查 Agent 配置和镜像版本。';
}
