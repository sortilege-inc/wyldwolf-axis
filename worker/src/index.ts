// wyldwolf-axis Worker: the D&D Beyond character proxy and the session
// rooms.
//
//   GET  /?id=<id|link>            D&D Beyond character JSON (CORS-scoped)
//   POST /session                  create a room → { code, gmToken }
//   GET  /session/:code            { exists }
//   GET  /session/:code/ws?token=  WebSocket into the room
//
// A SessionRoom is one Durable Object per room code. It holds the shared
// document (party, combat, maps, current scene) in SQLite, applies ops
// with the same ops.js the browser uses, and fans them out to every
// socket. Players get a filtered view (no GM notes, no hidden tokens).
// Rooms expire after 14 idle days.
import { DurableObject } from 'cloudflare:workers';
// @ts-ignore — plain JS, UMD; esbuild bundles it
import Ops from '../../assets/js/ops.js';

export interface Env {
  ALLOWED_ORIGIN: string;
  SESSION_ROOM: DurableObjectNamespace<SessionRoom>;
}

type Role = 'gm' | 'player';
interface Attachment {
  role: Role;
  memberId: string | null;
  token: string | null;
}
interface Doc {
  party: any[];
  combat: Record<string, any>;
  maps: Record<string, any>;
  trackerPage: Record<string, number>;
  sceneOrder: Record<string, unknown[]>;
}

const IDLE_MS = 14 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(len = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function originAllowed(env: Env, origin: string | null): boolean {
  if (!origin) return true; // same-origin fetches and non-browser clients
  if (origin === env.ALLOWED_ORIGIN) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function corsHeaders(env: Env, request: Request): HeadersInit {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin && originAllowed(env, origin) ? origin : env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function json(env: Env, request: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env, request) },
  });
}

// ── SessionRoom ──────────────────────────────────────────────────────
export class SessionRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS claims (member_id TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT NOT NULL, claimed_at INTEGER NOT NULL);
      `);
    });
  }

  private get(key: string): any {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM kv WHERE key = ?', key).toArray()[0];
    return row ? JSON.parse(row.value) : null;
  }

  private put(key: string, value: unknown): void {
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, JSON.stringify(value));
  }

  private touch(): void {
    this.put('lastActive', Date.now());
    this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  private claimsMap(): Record<string, { name: string }> {
    const out: Record<string, { name: string }> = {};
    this.ctx.storage.sql
      .exec<{ member_id: string; name: string }>('SELECT member_id, name FROM claims')
      .toArray()
      .forEach((r) => (out[r.member_id] = { name: r.name }));
    return out;
  }

  // RPC from the Worker
  async create(gmToken: string): Promise<void> {
    if (this.get('gmToken')) throw new Error('room exists');
    this.put('gmToken', gmToken);
    this.put('createdAt', Date.now());
    this.touch();
  }

  async exists(): Promise<boolean> {
    return !!this.get('gmToken');
  }

  async alarm(): Promise<void> {
    const last = this.get('lastActive') || 0;
    if (Date.now() - last < IDLE_MS) {
      this.ctx.storage.setAlarm(last + IDLE_MS);
      return;
    }
    for (const ws of this.ctx.getWebSockets()) ws.close(4000, 'session expired');
    await this.ctx.storage.deleteAll();
  }

  // WebSocket upgrade
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!this.get('gmToken')) return new Response('no such session', { status: 404 });
    const token = new URL(request.url).searchParams.get('token');
    const att = this.roleFor(token);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [att.role]);
    server.serializeAttachment(att);
    return new Response(null, { status: 101, webSocket: client });
  }

  private roleFor(token: string | null): Attachment {
    if (token && token === this.get('gmToken')) return { role: 'gm', memberId: null, token };
    if (token) {
      const row = this.ctx.storage.sql.exec<{ member_id: string }>('SELECT member_id FROM claims WHERE token = ?', token).toArray()[0];
      if (row) return { role: 'player', memberId: row.member_id, token };
    }
    return { role: 'player', memberId: null, token: null };
  }

  private sendTo(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      /* closed */
    }
  }

  private broadcast(build: (att: Attachment) => unknown | null, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const att = ws.deserializeAttachment() as Attachment;
      const msg = build(att);
      if (msg) this.sendTo(ws, msg);
    }
  }

  private snapshotFor(att: Attachment): unknown {
    const doc = this.get('doc') as Doc | null;
    return {
      type: 'snapshot',
      role: att.role,
      memberId: att.memberId,
      token: att.token,
      claims: this.claimsMap(),
      doc: doc ? (att.role === 'gm' ? doc : Ops.playerView(doc)) : null,
    };
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch (e) {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    this.touch();

    switch (msg.type) {
      case 'hello':
        this.sendTo(ws, this.snapshotFor(att));
        return;

      case 'init': {
        if (att.role !== 'gm') return this.sendTo(ws, { type: 'error', message: 'only the GM can seed a session' });
        if (this.get('doc') && !msg.force) return this.sendTo(ws, this.snapshotFor(att));
        const doc: Doc = { party: msg.doc?.party || [], combat: msg.doc?.combat || {}, maps: msg.doc?.maps || {}, trackerPage: msg.doc?.trackerPage || {}, sceneOrder: msg.doc?.sceneOrder || {} };
        this.put('doc', doc);
        this.broadcast((a) => this.snapshotFor(a));
        return;
      }

      case 'op': {
        const doc = this.get('doc') as Doc | null;
        if (!doc) return this.sendTo(ws, { type: 'error', message: 'session not seeded yet' });
        if (!Ops.permits(doc, att.role, att.memberId, msg.name, msg.args)) {
          return this.sendTo(ws, { type: 'error', message: `not allowed: ${msg.name}` });
        }
        try {
          Ops.apply(doc, msg.name, msg.args);
        } catch (e) {
          return this.sendTo(ws, { type: 'error', message: (e as Error).message });
        }
        this.put('doc', doc);
        const forPlayers = Ops.forPlayers(doc, msg.name, msg.args);
        this.broadcast((a) => {
          if (a.role === 'gm') return { type: 'op', name: msg.name, args: msg.args };
          return forPlayers ? { type: 'op', name: forPlayers.name, args: forPlayers.args } : null;
        }, ws);
        return;
      }

      case 'event': {
        const gmOnly = ['ping', 'select', 'scene:changed'];
        if (att.role !== 'gm' && gmOnly.indexOf(msg.name) !== -1 && msg.name !== 'ping') return;
        if (['roll', 'ping', 'select', 'scene:changed'].indexOf(msg.name) === -1) return;
        this.broadcast(() => ({ type: 'event', name: msg.name, payload: msg.payload }), ws);
        return;
      }

      case 'claim': {
        const doc = this.get('doc') as Doc | null;
        const m = doc && doc.party.find((x: any) => x.id === msg.memberId);
        if (!m) return this.sendTo(ws, { type: 'error', message: 'no such character' });
        const taken = this.ctx.storage.sql.exec<{ token: string }>('SELECT token FROM claims WHERE member_id = ?', msg.memberId).toArray()[0];
        if (taken && taken.token !== att.token && att.role !== 'gm') return this.sendTo(ws, { type: 'error', message: 'already claimed' });
        const token = att.role === 'player' && att.token ? att.token : randomToken();
        // one character per player token
        this.ctx.storage.sql.exec('DELETE FROM claims WHERE token = ?', token);
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO claims (member_id, token, name, claimed_at) VALUES (?, ?, ?, ?)', msg.memberId, token, m.snapshot?.name || 'Character', Date.now());
        if (att.role === 'player') {
          const next: Attachment = { role: 'player', memberId: msg.memberId, token };
          ws.serializeAttachment(next);
          this.sendTo(ws, { type: 'claimed', memberId: msg.memberId, token });
        }
        this.broadcast(() => ({ type: 'claims', claims: this.claimsMap() }));
        return;
      }

      case 'unclaim': {
        if (att.role !== 'gm' && att.memberId !== msg.memberId) return;
        this.ctx.storage.sql.exec('DELETE FROM claims WHERE member_id = ?', msg.memberId);
        for (const other of this.ctx.getWebSockets()) {
          const a = other.deserializeAttachment() as Attachment;
          if (a.role === 'player' && a.memberId === msg.memberId) {
            other.serializeAttachment({ role: 'player', memberId: null, token: null });
            this.sendTo(other, { type: 'claimed', memberId: null, token: null });
          }
        }
        this.broadcast(() => ({ type: 'claims', claims: this.claimsMap() }));
        return;
      }

      default:
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch (e) {
      /* already closed */
    }
  }
}

// ── D&D Beyond proxy ─────────────────────────────────────────────────
const DDB_API_BASE = 'https://character-service.dndbeyond.com/character/v5/character';

function extractCharacterId(raw: string | null): string | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const m = raw.match(/dndbeyond\.com\/characters\/(\d+)/i);
  return m ? m[1] : null;
}

async function ddbProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = extractCharacterId(url.searchParams.get('id'));
  if (!id) return json(env, request, 400, { success: false, message: 'Missing or invalid `id` (character id or dndbeyond.com/characters/<id> link).' });
  let upstream: Response;
  try {
    upstream = await fetch(`${DDB_API_BASE}/${id}?includeCustomItems=true`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; wyldwolf-axis/1.0)',
        Accept: 'application/json',
        Origin: 'https://www.dndbeyond.com',
        Referer: 'https://www.dndbeyond.com/',
      },
    });
  } catch (err) {
    return json(env, request, 502, { success: false, message: `Could not reach D&D Beyond: ${(err as Error).message}` });
  }
  if (!upstream.ok) {
    return json(env, request, upstream.status === 404 ? 404 : 502, { success: false, message: `D&D Beyond returned HTTP ${upstream.status} for character ${id}.` });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', ...corsHeaders(env, request) },
  });
}

// ── router ───────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(env, request) });
    const origin = request.headers.get('Origin');
    if (!originAllowed(env, origin)) return json(env, request, 403, { success: false, message: 'origin not allowed' });

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'session') {
      if (parts.length === 1 && request.method === 'POST') {
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = randomCode();
          const stub = env.SESSION_ROOM.getByName(code);
          if (await stub.exists()) continue;
          const gmToken = randomToken();
          await stub.create(gmToken);
          return json(env, request, 200, { code, gmToken });
        }
        return json(env, request, 500, { success: false, message: 'could not allocate a room code' });
      }
      const code = (parts[1] || '').toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) return json(env, request, 400, { success: false, message: 'bad room code' });
      const stub = env.SESSION_ROOM.getByName(code);
      if (parts[2] === 'ws') return stub.fetch(request);
      if (parts.length === 2 && request.method === 'GET') return json(env, request, 200, { exists: await stub.exists() });
      return json(env, request, 404, { success: false, message: 'not found' });
    }

    if (request.method === 'GET' && parts.length === 0) return ddbProxy(request, env);
    return json(env, request, 404, { success: false, message: 'not found' });
  },
};
