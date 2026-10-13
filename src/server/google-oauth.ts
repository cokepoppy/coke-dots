import { OAuth2Client } from 'google-auth-library';

export function createGoogleOAuthClient(clientId: string, clientSecret: string, redirectUri: string) {
  const testProviderOrigin = e2eGoogleProviderOrigin();
  const proxy = googleOAuthProxyUrl();
  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri,
    transporterOptions: { timeout: 15_000, ...(proxy ? { proxy } : {}) },
    ...(testProviderOrigin ? {
      endpoints: {
        oauth2AuthBaseUrl: `${testProviderOrigin}/authorize`,
        oauth2TokenUrl: `${testProviderOrigin}/token`,
        oauth2FederatedSignonPemCertsUrl: `${testProviderOrigin}/certs`,
        oauth2FederatedSignonJwkCertsUrl: `${testProviderOrigin}/certs`,
        tokenInfoUrl: `${testProviderOrigin}/tokeninfo`,
      },
    } : {}),
  });
}

/** Do not retry a Google authorization-code POST: the code is single use. */
export function disableOAuthCodeExchangeRetries(client: OAuth2Client) {
  const originalRequest = client.transporter.request.bind(client.transporter);
  client.transporter.request = options => {
    if (!options) return originalRequest(options);
    const requestUrl = options.url ? new URL(String(options.url)) : null;
    if (options.method?.toUpperCase() === 'POST' && requestUrl?.pathname.endsWith('/token')) {
      return originalRequest({ ...options, retry: false, retryConfig: { retry: 0, httpMethodsToRetry: [] } });
    }
    return originalRequest(options);
  };
}

function googleOAuthProxyUrl() {
  const configured = process.env.DOTS_GOOGLE_OAUTH_PROXY_URL?.trim();
  if (!configured) return '';
  try {
    const proxy = new URL(configured);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error();
    return proxy.origin;
  } catch { throw new Error('DOTS_GOOGLE_OAUTH_PROXY_URL must be an HTTP(S) proxy origin without credentials or a path'); }
}

function e2eGoogleProviderOrigin() {
  if (process.env.NODE_ENV !== 'test' || process.env.DOTS_E2E_AUTH !== '1') return '';
  try {
    const url = new URL(process.env.DOTS_E2E_GOOGLE_PROVIDER_URL || '');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch { return ''; }
}
