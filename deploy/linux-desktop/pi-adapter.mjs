import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

try {
  const input = JSON.parse(raw);
  const config = input.modelConfig;
  if (!config || typeof config.apiKey !== 'string' || typeof config.model !== 'string' || typeof config.baseUrl !== 'string') {
    throw new Error('Pi needs the shared model API configuration');
  }

  const sdk = await import('@mariozechner/pi-coding-agent');
  const provider = 'coke-dots-shared';
  const authStorage = sdk.AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(provider, config.apiKey);
  const modelRegistry = sdk.ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(provider, {
    name: 'Coke Dots shared model',
    baseUrl: config.baseUrl,
    apiKey: 'COKE_DOTS_RUNTIME_KEY_REQUIRED',
    api: 'openai-completions',
    models: [{
      id: config.model,
      name: config.model,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
      compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    }],
  });
  const model = modelRegistry.find(provider, config.model);
  if (!model) throw new Error('Pi could not load the shared model profile');

  const cwd = await realpath(input.cwd);
  const sessionDirectory = path.join(cwd, '.coke-dots', 'pi-sessions');
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const privateSessionDirectory = await realpath(sessionDirectory);
  const relativeSessionDirectory = path.relative(cwd, privateSessionDirectory);
  if (relativeSessionDirectory.startsWith('..') || path.isAbsolute(relativeSessionDirectory)) throw new Error('Pi session directory escaped its task workspace');
  const agentDirectory = path.join(cwd, '.coke-dots', 'pi-agent');
  await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  const sessions = await sdk.SessionManager.list(cwd, privateSessionDirectory);
  let selected;
  if (input.sessionId) {
    const matches = sessions.filter(session => session.id === input.sessionId);
    if (matches.length !== 1) throw new Error('Pi session is missing or ambiguous; refusing to switch task context');
    selected = matches[0];
  } else if (sessions.length === 1) selected = sessions[0];
  else if (sessions.length > 1) throw new Error('Pi task has multiple sessions but no session ID; refusing to mix task context');

  const sessionManager = selected
    ? sdk.SessionManager.open(await realpath(selected.path), privateSessionDirectory, cwd)
    : sdk.SessionManager.create(cwd, privateSessionDirectory);
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: agentDirectory,
    authStorage,
    modelRegistry,
    model,
    tools: input.executionMode === 'proactive-research' ? [] : ['read', 'grep', 'find', 'ls'],
    sessionManager,
  });
  try {
    await session.prompt(input.prompt);
    const assistant = [...session.messages].reverse().find(row => row?.role === 'assistant');
    const text = assistant?.content?.filter(item => item?.type === 'text').map(item => item.text || '').join('\n') || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      const shape = { role: assistant?.role, contentType: Array.isArray(assistant?.content) ? assistant.content.map(item => item?.type) : typeof assistant?.content };
      throw new Error(`Pi did not return a structured decision (${JSON.stringify(shape)})`);
    }
    const decision = JSON.parse(match[0]);
    if (!['done', 'waiting', 'scheduled', 'delegating'].includes(decision.status) || typeof decision.message !== 'string' || !decision.message.trim()) {
      throw new Error('Pi returned an invalid task decision');
    }
    if (input.executionMode === 'proactive-research' && (decision.status !== 'done' || typeof decision.proactiveFinding !== 'boolean' || decision.pageAction !== undefined || decision.delegations !== undefined || decision.nextMinutes !== undefined)) {
      throw new Error('Pi returned an invalid proactive research decision');
    }
    process.stdout.write(JSON.stringify({ ...decision, sessionId: sessionManager.getSessionId() }));
  } finally {
    session.dispose();
  }
} catch (error) {
  let diagnostic = 'Pi adapter failed; details were suppressed to protect model credentials.';
  if (process.env.DOTS_PI_ADAPTER_TEST_DIAGNOSTICS === '1') {
    try {
      const apiKey = JSON.parse(raw)?.modelConfig?.apiKey;
      diagnostic = String(error instanceof Error ? `${error.name}: ${error.message}` : 'Pi adapter test failed').replaceAll(apiKey || '\u0000', '[REDACTED]').slice(0, 1000);
    } catch { /* Keep the generic diagnostic when no safe detail is available. */ }
  }
  process.stderr.write(`${diagnostic}\n`);
  process.exitCode = 1;
}
