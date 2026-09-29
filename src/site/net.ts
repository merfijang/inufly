// WebSocket to the fly server, with reconnect. JSON messages are protocol events; binary is activity.
import type { ServerMessage } from '../shared/protocol';

export function serverUrl() {
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env;
  // dev: Vite on :5173, fly server on :8788. Otherwise the fly server sits behind the same host at /ws.
  if (location.port === '5173') return `ws://${location.hostname}:8788/ws`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** The neuron labels ship with the site's assets (public/brain/meta.bin). */
export const brainMetaUrl = () => `${import.meta.env.BASE_URL}brain/meta.bin`;

export function connect(url: string, on: { message(m: ServerMessage): void; activity(bytes: Uint8Array): void; status(live: boolean): void }) {
  let delay = 1000;
  const open = () => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { delay = 1000; on.status(true); };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') on.message(JSON.parse(e.data) as ServerMessage);
      else on.activity(new Uint8Array(e.data as ArrayBuffer));
    };
    ws.onclose = () => { on.status(false); setTimeout(open, delay); delay = Math.min(15000, delay * 2); };
  };
  open();
}
