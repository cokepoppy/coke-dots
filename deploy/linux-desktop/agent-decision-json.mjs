/**
 * Parse one JSON object from an Agent response. Some model adapters return
 * literal line breaks inside quoted JSON strings; escape those control
 * characters without changing JSON escapes or repairing other syntax errors.
 */
export function parseAgentDecisionJson(raw) {
  if (typeof raw !== 'string') throw new Error('代理没有返回结构化结果');

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start === -1) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }

  if (start === -1 || end === -1) throw new Error('代理没有返回结构化结果');
  const candidate = raw.slice(start, end);
  let sanitized = '';
  inString = false;
  escaped = false;
  for (const character of candidate) {
    const code = character.charCodeAt(0);
    if (inString && !escaped && code < 0x20) {
      if (character === '\n') sanitized += '\\n';
      else if (character === '\r') sanitized += '\\r';
      else if (character === '\t') sanitized += '\\t';
      else sanitized += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    sanitized += character;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
  }

  try {
    return JSON.parse(sanitized);
  } catch {
    throw new Error('代理返回的结构化结果不是有效 JSON');
  }
}
