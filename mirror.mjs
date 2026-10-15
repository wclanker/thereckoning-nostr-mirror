// X -> Nostr mirror for @TheReckoning21 (The Reckoning)
// Each run: fetch new posts from X since the last mirrored one, re-host media on Blossom,
// publish each post verbatim as a Nostr note (kind 1), and record progress in state.json.

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

useWebSocketImplementation(WebSocket);

const env = process.env;
const list = (v, d) => (v || d).split(',').map((s) => s.trim()).filter(Boolean);

export const CONFIG = {
  xBearer: env.X_BEARER_TOKEN,
  xUsername: (env.X_USERNAME || 'TheReckoning21').replace(/^@/, ''),
  nsec: env.NOSTR_NSEC,
  relays: list(env.NOSTR_RELAYS, 'wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net'),
  blossom: list(env.BLOSSOM_SERVERS, 'https://blossom.primal.net'),
  mirrorRetweets: env.MIRROR_RETWEETS === 'true', // reposts of other people's posts
  mirrorReplies: env.MIRROR_REPLIES === 'true', // replies to other people (self-threads are always mirrored)
  backfill: Math.min(parseInt(env.BACKFILL || '0', 10) || 0, 100), // posts to copy on the very first run
  dryRun: env.DRY_RUN === 'true',
  keepOriginalTime: env.KEEP_ORIGINAL_TIME === 'true', // default: stamp notes with publish time (Primal ignores backdated notes)
  repost: env.REPOST === 'true', // with POST_IDS: delete the earlier Nostr copy and post again
  postIds: (env.POST_IDS || '').split(/[\s,]+/).map((v) => (v.match(/(\d{5,})\/?(?:\?.*)?$/) || [])[1]).filter(Boolean), // copy specific posts (IDs or URLs)
  stateFile: env.STATE_FILE || 'state.json',
};

const MAP_LIMIT = 1000; // how many X-id -> Nostr-id pairs to remember (for threading)

// ---------- helpers ----------

const byIdAsc = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function secretKey() {
  if (!CONFIG.nsec) {
    if (CONFIG.dryRun) return generateSecretKey();
    throw new Error('NOSTR_NSEC is not set');
  }
  const k = CONFIG.nsec.trim();
  if (k.startsWith('nsec')) return nip19.decode(k).data;
  if (/^[0-9a-f]{64}$/i.test(k)) return Uint8Array.from(Buffer.from(k, 'hex'));
  throw new Error('NOSTR_NSEC must be an nsec1... key or 64-char hex');
}

async function loadState() {
  try {
    return JSON.parse(await readFile(CONFIG.stateFile, 'utf8'));
  } catch {
    return {};
  }
}

async function saveState(state) {
  if (CONFIG.dryRun) return;
  const keys = Object.keys(state.map || {}).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  if (keys.length > MAP_LIMIT) for (const k of keys.slice(0, keys.length - MAP_LIMIT)) delete state.map[k];
  await writeFile(CONFIG.stateFile, JSON.stringify(state, null, 2) + '\n');
}

// ---------- X ----------

async function xGet(path, params = {}) {
  if (!CONFIG.xBearer) throw new Error('X_BEARER_TOKEN is not set');
  const url = new URL('https://api.x.com/2' + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${CONFIG.xBearer}` } });
  if (res.status === 429) throw new Error('X API rate limit (429) - will retry next run');
  if (!res.ok) throw new Error(`X API ${res.status}: ${await res.text()}`);
  return res.json();
}

const POST_FIELDS = {
  'tweet.fields': 'created_at,entities,note_tweet,referenced_tweets,in_reply_to_user_id,attachments,conversation_id,author_id',
  expansions: 'attachments.media_keys,referenced_tweets.id',
  'media.fields': 'type,url,variants,preview_image_url,alt_text,width,height',
};

async function fetchByIds(ids) {
  const r = await xGet('/tweets', { ids: ids.join(','), ...POST_FIELDS });
  for (const e of r.errors || []) console.warn(`  could not fetch ${e.value || e.resource_id}: ${e.detail || e.title}`);
  const media = {};
  for (const m of r.includes?.media || []) media[m.media_key] = m;
  return { posts: (r.data || []).sort(byIdAsc), media };
}

async function fetchPosts(userId, sinceId, maxResults) {
  const posts = [];
  const media = {};
  let token;
  do {
    const r = await xGet(`/users/${userId}/tweets`, {
      max_results: maxResults,
      since_id: sinceId,
      pagination_token: token,
      exclude: CONFIG.mirrorRetweets ? undefined : 'retweets',
      ...POST_FIELDS,
    });
    posts.push(...(r.data || []));
    for (const m of r.includes?.media || []) media[m.media_key] = m;
    token = sinceId ? r.meta?.next_token : undefined; // only page through when catching up
  } while (token);
  return { posts: posts.sort(byIdAsc), media };
}

// ---------- content ----------

// Post text exactly as written, with t.co links expanded and the t.co links X adds for attached media removed.
export function buildText(post) {
  const src = post.note_tweet?.text ? post.note_tweet : post; // long posts live in note_tweet
  let text = src.text || '';
  for (const u of src.entities?.urls || []) {
    const exp = u.expanded_url || '';
    const isMedia = !!u.media_key || /\/status\/\d+\/(photo|video)\/\d+$/.test(exp);
    text = text.split(u.url).join(isMedia ? '' : u.unwound_url || exp || u.url);
  }
  text = decodeEntities(text).replace(/[ \t]+$/gm, '').trim();

  const quoted = post.referenced_tweets?.find((r) => r.type === 'quoted');
  if (quoted && !text.includes(`/status/${quoted.id}`)) text += `${text ? '\n\n' : ''}https://x.com/i/status/${quoted.id}`;

  const rt = post.referenced_tweets?.find((r) => r.type === 'retweeted');
  if (rt && !text.includes(`/status/${rt.id}`)) text += `\n\nhttps://x.com/i/status/${rt.id}`;
  return text;
}

export function sourceMedia(m) {
  if (m.type === 'photo' && m.url) {
    const url = m.url.includes('?') ? m.url : `${m.url}?name=orig`;
    return { url };
  }
  const mp4 = (m.variants || [])
    .filter((v) => v.content_type === 'video/mp4')
    .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
  return mp4 ? { url: mp4.url, mime: 'video/mp4' } : null;
}

async function blossomUpload(bytes, mime, sk) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  const auth = finalizeEvent(
    { kind: 24242, created_at: now, content: 'Upload file', tags: [['t', 'upload'], ['x', sha], ['expiration', String(now + 600)]] },
    sk,
  );
  const header = 'Nostr ' + Buffer.from(JSON.stringify(auth)).toString('base64');
  for (const server of CONFIG.blossom) {
    try {
      const res = await fetch(server.replace(/\/$/, '') + '/upload', {
        method: 'PUT',
        headers: { Authorization: header, 'Content-Type': mime, 'X-SHA-256': sha },
        body: bytes,
      });
      if (res.ok) {
        const d = await res.json();
        return { url: d.url, sha, size: bytes.length, mime: d.type || mime };
      }
      console.warn(`  Blossom ${server} refused upload: ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      console.warn(`  Blossom ${server} failed: ${e.message}`);
    }
  }
  return null;
}

async function rehost(m, sk) {
  const src = sourceMedia(m);
  if (!src) return null;
  if (CONFIG.dryRun) return { url: src.url, fallback: true };
  try {
    const res = await fetch(src.url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const mime = src.mime || res.headers.get('content-type') || 'application/octet-stream';
    const up = await blossomUpload(bytes, mime, sk);
    if (up) return up;
  } catch (e) {
    console.warn(`  media ${m.media_key}: ${e.message}`);
  }
  console.warn(`  media ${m.media_key}: re-hosting failed, linking the X copy instead`);
  return { url: src.url, fallback: true };
}

export function buildEvent({ post, text, uploads, thread, pubkey, createdAt }) {
  const lines = text ? [text] : [];
  const tags = [];
  for (const { m, up } of uploads) {
    lines.push(up.url);
    if (!up.fallback) {
      const imeta = ['imeta', `url ${up.url}`, `m ${up.mime}`, `x ${up.sha}`, `size ${up.size}`];
      if (m.width && m.height) imeta.push(`dim ${m.width}x${m.height}`);
      if (m.alt_text) imeta.push(`alt ${m.alt_text}`);
      tags.push(imeta);
    }
  }
  for (const r of text.match(/https?:\/\/\S+/g) || []) tags.push(['r', r]);
  if (thread) {
    tags.push(['e', thread.rootId, '', 'root']);
    if (thread.parentId !== thread.rootId) tags.push(['e', thread.parentId, '', 'reply']);
    tags.push(['p', pubkey]);
  }
  const created = createdAt || Math.floor(Date.parse(post.created_at) / 1000) || Math.floor(Date.now() / 1000);
  return { kind: 1, created_at: created, content: lines.join('\n'), tags };
}

async function publish(pool, event) {
  const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
  const results = await Promise.allSettled(pool.publish(CONFIG.relays, event).map((p) => Promise.race([p, timeout(15000)])));
  results.forEach((r, i) => r.status === 'rejected' && console.warn(`  relay ${CONFIG.relays[i]}: ${r.reason?.message || r.reason}`));
  return results.filter((r) => r.status === 'fulfilled').length;
}

// ---------- main ----------

async function main() {
  const sk = secretKey();
  const pubkey = getPublicKey(sk);
  const state = await loadState();
  state.map ||= {};
  console.log(`Mirroring @${CONFIG.xUsername} -> ${nip19.npubEncode(pubkey)}${CONFIG.dryRun ? ' (DRY RUN)' : ''}`);

  if (!state.userId) {
    const u = await xGet(`/users/by/username/${CONFIG.xUsername}`);
    state.userId = u.data.id;
    await saveState(state);
  }

  // Manual copy of specific posts (e.g. older ones): doesn't move the starting point.
  if (CONFIG.postIds.length) {
    const { posts, media } = await fetchByIds(CONFIG.postIds);
    const own = posts.filter((p) => p.author_id === state.userId && (CONFIG.repost || !state.map[p.id]));
    for (const p of posts) if (p.author_id !== state.userId) console.log(`skip ${p.id} (not posted by @${CONFIG.xUsername})`);
    if (!CONFIG.repost) for (const p of posts) if (state.map[p.id]) console.log(`skip ${p.id} (already mirrored; tick "repost" to post it again)`);
    if (!own.length) return console.log('Nothing to copy.');
    return mirrorAll(own, media, state, sk, pubkey, { manual: true });
  }

  // First run: remember where the timeline is now (optionally copying the last BACKFILL posts).
  if (!state.baselined) {
    const { posts, media } = await fetchPosts(state.userId, undefined, Math.max(CONFIG.backfill, 5));
    state.baselined = true;
    if (!CONFIG.backfill) {
      if (posts.length) state.lastId = posts[posts.length - 1].id;
      await saveState(state);
      console.log(`First run: starting from post ${state.lastId || '(none yet)'}; new posts from now on will be mirrored.`);
      return;
    }
    return mirrorAll(posts.slice(-CONFIG.backfill), media, state, sk, pubkey);
  }

  const { posts, media } = await fetchPosts(state.userId, state.lastId, 100);
  if (!posts.length) return console.log('No new posts.');
  return mirrorAll(posts, media, state, sk, pubkey);
}

async function mirrorAll(posts, media, state, sk, pubkey, { manual = false } = {}) {
  const advance = (id) => {
    if (!manual) state.lastId = id;
  };
  let lastCreated = 0;
  const stamp = (post) => {
    if (CONFIG.keepOriginalTime) return undefined;
    lastCreated = Math.max(Math.floor(Date.now() / 1000), lastCreated + 1); // keeps batch order
    return lastCreated;
  };
  const pool = new SimplePool();
  try {
    for (const post of posts) {
      const reply = post.referenced_tweets?.find((r) => r.type === 'replied_to');
      const selfThread = reply && post.in_reply_to_user_id === state.userId;
      if (reply && !selfThread && !CONFIG.mirrorReplies) {
        console.log(`skip ${post.id} (reply to someone else)`);
        advance(post.id);
        await saveState(state);
        continue;
      }

      const text = buildText(post);
      const uploads = [];
      for (const key of post.attachments?.media_keys || []) {
        const m = media[key];
        if (!m) continue;
        const up = await rehost(m, sk);
        if (up) uploads.push({ m, up });
      }

      let thread = null;
      const parent = selfThread && state.map[reply.id];
      if (parent) thread = { rootId: parent.rootId, parentId: parent.eventId };

      const event = finalizeEvent(buildEvent({ post, text, uploads, thread, pubkey, createdAt: stamp(post) }), sk);

      if (CONFIG.dryRun) {
        console.log(JSON.stringify(event, null, 2));
        state.map[post.id] = { eventId: event.id, rootId: thread?.rootId || event.id }; // in memory only
        continue;
      }
      const previous = manual && CONFIG.repost && state.map[post.id];
      if (previous) {
        const del = finalizeEvent(
          { kind: 5, created_at: Math.floor(Date.now() / 1000), content: 'Re-posted', tags: [['e', previous.eventId], ['k', '1']] },
          sk,
        );
        console.log(`  deleting earlier copy ${nip19.noteEncode(previous.eventId)}: ${await publish(pool, del)}/${CONFIG.relays.length} relays`);
      }
      const ok = await publish(pool, event);
      if (!ok) throw new Error(`No relay accepted post ${post.id}; will retry next run`);

      state.map[post.id] = { eventId: event.id, rootId: thread?.rootId || event.id };
      advance(post.id);
      await saveState(state);
      console.log(`mirrored ${post.id} -> ${nip19.noteEncode(event.id)} (${ok}/${CONFIG.relays.length} relays)`);
    }
  } finally {
    pool.close(CONFIG.relays);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
