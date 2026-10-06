export function redactSecret(value: string, secret: string) {
  const withExactSecretRedacted = secret ? value.replaceAll(secret, '[redacted]') : value;
  return withExactSecretRedacted.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]');
}
