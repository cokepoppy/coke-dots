export function isE2EBrowserResearchFixture(value: string, environment?: NodeJS.ProcessEnv): boolean;
export function validatePublicHttpsUrl(value: string, options?: {
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  dnsTimeoutMs?: number;
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>;
}): Promise<string>;
export function fetchPublicPageHtml(value: string, options?: {
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  dnsTimeoutMs?: number;
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>;
  request?: (resolved: { url: URL; hostname: string; address: string | null; family: number; fixture?: boolean }, signal?: AbortSignal, timeoutMs?: number) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>;
}): Promise<{ url: string; html: string }>;
export function sanitizePublicHtml(html: string): string;
export function isPublicIpAddress(address: string): boolean;
