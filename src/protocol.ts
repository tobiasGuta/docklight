/** Strict read-only message allowlist. The extension host validates inventory membership. */
export type WebviewMessage =
  | Readonly<{ type: 'ready' | 'refresh' | 'clearSelection' | 'loadLogs' }>
  | Readonly<{ type: 'select'; id: string }>;

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (message.type === 'select') {
    if (Object.keys(message).length !== 2 || typeof message.id !== 'string' || !/^[0-9a-f]{64}$/.test(message.id)) return undefined;
    return { type: 'select', id: message.id };
  }
  if (Object.keys(message).length !== 1 || typeof message.type !== 'string' || ![
    'ready', 'refresh', 'clearSelection', 'loadLogs',
  ].includes(message.type)) return undefined;
  return { type: message.type as 'ready' | 'refresh' | 'clearSelection' | 'loadLogs' };
}
