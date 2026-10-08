export type PublicComputerAction = { action: 'inspect' | 'navigate' | 'click'; host: string };
export function toPublicComputerActionRecord(action: string, pageUrl: string): PublicComputerAction | null;
