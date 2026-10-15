import { DWClient, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream';
import type { DingTalkStreamMessage } from './store.ts';

export interface DingTalkStreamStatus {
  configured: boolean;
  connected: boolean;
  ready: boolean;
  testOnly: boolean;
}

export interface DingTalkStreamConfiguration {
  clientId: string;
  clientSecret: string;
  /** Optional deployment pin; group selection still enforces the verified per-user corpId. */
  corpId?: string;
}

export function dingtalkStreamConfiguration(env: NodeJS.ProcessEnv = process.env): DingTalkStreamConfiguration | null {
  const clientId = env.DOTS_DINGTALK_STREAM_CLIENT_ID?.trim() || '';
  const clientSecret = env.DOTS_DINGTALK_STREAM_CLIENT_SECRET?.trim() || '';
  const corpId = env.DOTS_DINGTALK_STREAM_CORP_ID?.trim() || '';
  if (!clientId || !clientSecret || clientId.length > 256 || clientSecret.length > 1024 || corpId.length > 256) return null;
  return { clientId, clientSecret, ...(corpId ? { corpId } : {}) };
}

export function normalizeDingTalkRobotMessage(message: DWClientDownStream, configuration: DingTalkStreamConfiguration): DingTalkStreamMessage | null {
  if (message.headers?.topic !== TOPIC_ROBOT || message.headers.appId !== configuration.clientId) return null;
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(message.data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch { return null; }

  // DingTalk's robot-message callback only emits group messages after the bot is mentioned.
  // Direct messages and non-text payloads are acknowledged but do not create tasks.
  const corpId = String(payload.chatbotCorpId || '');
  if (String(payload.conversationType || '') !== '2' || !corpId || (configuration.corpId && corpId !== configuration.corpId) || payload.msgtype !== 'text') return null;
  const textValue = payload.text;
  const text = textValue && typeof textValue === 'object' && !Array.isArray(textValue)
    ? String((textValue as Record<string, unknown>).content || '') : '';
  const messageId = String(payload.msgId || message.headers.messageId || '');
  const conversationId = String(payload.conversationId || '');
  if (!text.trim() || !messageId.trim() || !conversationId.trim()) return null;
  return {
    corpId,
    conversationId,
    messageId,
    senderId: String(payload.senderStaffId || payload.senderId || ''),
    senderName: String(payload.senderNick || ''),
    text: text.slice(0, 6000),
  };
}

export class DingTalkStreamService {
  private readonly configuration: DingTalkStreamConfiguration | null;
  private readonly testOnly: boolean;
  private client: DWClient | null = null;

  constructor(private readonly ingest: (message: DingTalkStreamMessage) => Promise<void> | void, env: NodeJS.ProcessEnv = process.env) {
    this.testOnly = env.NODE_ENV === 'test' && env.DOTS_E2E_AUTH === '1' && env.DOTS_E2E_DINGTALK === '1';
    this.configuration = dingtalkStreamConfiguration(env) || (this.testOnly
      ? { clientId: 'e2e-dingtalk-app', clientSecret: 'e2e-only-secret', corpId: 'e2e-corp' }
      : null);
  }

  status(): DingTalkStreamStatus {
    if (this.testOnly) return { configured: true, connected: true, ready: true, testOnly: true };
    const connected = Boolean(this.client?.connected);
    const registered = Boolean(this.client?.registered);
    return { configured: Boolean(this.configuration), connected, ready: connected && registered, testOnly: false };
  }

  canMonitor(corpId: string): boolean {
    return Boolean(this.configuration && corpId && (!this.configuration.corpId || corpId === this.configuration.corpId) && this.status().ready);
  }

  start() {
    if (this.testOnly || !this.configuration || this.client) return;
    const client = new DWClient({
      clientId: this.configuration.clientId,
      clientSecret: this.configuration.clientSecret,
      autoReconnect: true,
      debug: false,
      maxPendingCallbackHandlers: 20,
      subscriptions: [{ type: 'CALLBACK', topic: TOPIC_ROBOT }],
    });
    this.client = client;
    client.on('error', () => console.error('DingTalk Stream transport error'));
    client.registerCallbackListener(TOPIC_ROBOT, async message => {
      try {
        const normalized = normalizeDingTalkRobotMessage(message, this.configuration!);
        if (normalized) await this.ingest(normalized);
        // ACK only after the message is either durably queued or safely ignored.
        client.socketCallBackResponse(message.headers.messageId, null);
      } catch {
        // Leave transient storage/queue failures unacknowledged so DingTalk can retry.
        console.error('DingTalk Stream callback processing failed; callback left unacknowledged');
      }
    });
    void client.connect().catch(() => console.error('DingTalk Stream connection failed; automatic reconnect remains enabled'));
  }

  stop() {
    this.client?.disconnect();
    this.client = null;
  }
}
