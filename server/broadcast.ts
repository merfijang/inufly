// HTTP (health, stats) + WebSocket fan-out. Slow viewers skip messages instead of piling up memory.
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerMessage, Stats } from '../src/shared/protocol';
import type { Outbox } from './flyServer';

const MAX_BUFFERED = 512 * 1024;

export class Broadcaster implements Outbox {
  readonly http: Server;
  private readonly wss: WebSocketServer;

  constructor(private readonly source: { hello(): ServerMessage; stats(): Stats; grant?(n: number): number }, corsOrigin = '*', private readonly adminToken: string | null = null) {
    this.http = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0];
      res.setHeader('access-control-allow-origin', corsOrigin);
      if (path === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return; }
      if (path === '/stats') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.source.stats())); return; }
      // a launch push: POST /admin/attempts?n=20 with the admin token
      if (path === '/admin/attempts' && req.method === 'POST') {
        if (!this.adminToken || req.headers['x-admin-token'] !== this.adminToken) { res.writeHead(403).end(); return; }
        const n = Number(new URL(req.url ?? '', 'http://x').searchParams.get('n') ?? 0);
        try {
          const queue = this.source.grant?.(n) ?? 0;
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ granted: n, queue }));
        } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); }
        return;
      }
      res.writeHead(404).end();
    });
    this.wss = new WebSocketServer({ server: this.http, path: '/ws' });
    this.wss.on('connection', (ws) => ws.send(JSON.stringify(this.source.hello())));
  }

  get viewers() { return this.wss.clients.size; }

  listen(port: number, host?: string) { return new Promise<number>((ok) => this.http.listen(port, host, () => ok((this.http.address() as { port: number }).port))); }

  json(msg: ServerMessage) { this.send(JSON.stringify(msg)); }
  binary(bytes: Uint8Array) { this.send(bytes); }

  private send(data: string | Uint8Array) {
    for (const ws of this.wss.clients) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFERED) ws.send(data);
  }

  close() {
    for (const ws of this.wss.clients) ws.terminate();
    return new Promise<void>((ok) => this.wss.close(() => this.http.close(() => ok())));
  }
}
