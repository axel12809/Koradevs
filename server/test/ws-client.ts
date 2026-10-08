import WebSocket from 'ws';
import type { ServerMessage } from '@sos/shared';

/** A WebSocket client that records every message and lets tests wait for one. */
export class Client {
  readonly messages: ServerMessage[] = [];
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  private readonly ws: WebSocket;
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve) => this.ws.once('open', () => resolve()));
    this.ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as ServerMessage;
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => (w.match(m) ? (w.resolve(m), false) : true));
    });
  }

  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }

  next<T extends ServerMessage['type']>(type: T, match: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true) {
    const test = (m: ServerMessage) => m.type === type && match(m as Extract<ServerMessage, { type: T }>);
    const found = this.messages.find(test);
    if (found) {
      this.messages.splice(this.messages.indexOf(found), 1);
      return Promise.resolve(found as Extract<ServerMessage, { type: T }>);
    }
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`pas de message « ${type} »`)), 2000);
      this.waiters.push({
        match: test,
        resolve: (m) => {
          clearTimeout(timer);
          this.messages.splice(this.messages.indexOf(m), 1);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }

  has(type: ServerMessage['type']) {
    return this.messages.some((m) => m.type === type);
  }

  close() {
    this.ws.close();
  }
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 50));
