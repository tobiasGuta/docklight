/** Only the documented, read-only dashboard handshake is accepted in Phase 2. */
export type WebviewMessage = Readonly<{ type: 'ready' }>;

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const message = value as Record<string, unknown>;
  if (Object.keys(message).length !== 1 || message.type !== 'ready') {
    return undefined;
  }

  return { type: 'ready' };
}
