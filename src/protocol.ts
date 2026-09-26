/** Strict, read-only Webview message allowlist. No arbitrary Docker arguments. */
export type WebviewMessage = Readonly<{ type: 'ready' | 'refresh' }>;

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const message = value as Record<string, unknown>;
  if (Object.keys(message).length !== 1 || (message.type !== 'ready' && message.type !== 'refresh')) {
    return undefined;
  }
  return { type: message.type };
}
