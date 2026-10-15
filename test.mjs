// Offline checks of the text/media/event transforms against sample X API payloads.
process.env.DRY_RUN = 'true';
const { buildText, sourceMedia, buildEvent, linkMentions } = await import('./mirror.mjs');
import assert from 'node:assert/strict';

// 1. Photo post with a link: t.co link expanded, media t.co removed, entities decoded
const photoPost = {
  id: '1900000000000000001',
  created_at: '2026-10-15T12:00:00.000Z',
  text: 'Live every Friday &amp; stay free https://t.co/abc123 https://t.co/media999',
  attachments: { media_keys: ['3_1'] },
  entities: {
    urls: [
      { url: 'https://t.co/abc123', expanded_url: 'https://thereckoning.tv' },
      { url: 'https://t.co/media999', expanded_url: 'https://x.com/TheReckoning21/status/1900000000000000001/photo/1', media_key: '3_1' },
    ],
  },
};
assert.equal(buildText(photoPost), 'Live every Friday & stay free https://thereckoning.tv');

const photo = { media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/AbC.jpg', width: 1080, height: 1350, alt_text: 'The plumb line' };
assert.equal(sourceMedia(photo).url, 'https://pbs.twimg.com/media/AbC.jpg?name=orig');

// 2. Video picks highest bitrate mp4
const video = {
  type: 'video',
  variants: [
    { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x.m3u8' },
    { content_type: 'video/mp4', bit_rate: 832000, url: 'https://video.twimg.com/low.mp4' },
    { content_type: 'video/mp4', bit_rate: 10368000, url: 'https://video.twimg.com/high.mp4' },
  ],
};
assert.equal(sourceMedia(video).url, 'https://video.twimg.com/high.mp4');

// 3. Long post uses note_tweet text
const longPost = { id: '2', text: 'truncated…', note_tweet: { text: 'The whole long post', entities: { urls: [] } } };
assert.equal(buildText(longPost), 'The whole long post');

// 4. Quote post gets the quoted post link appended if missing
const quote = { id: '3', text: 'This.', referenced_tweets: [{ type: 'quoted', id: '1888' }] };
assert.equal(buildText(quote), 'This.\n\nhttps://x.com/i/status/1888');

// 5. Event shape: media URLs appended, imeta tags, thread tags
const uploads = [{ m: photo, up: { url: 'https://blossom.primal.net/abc.jpg', mime: 'image/jpeg', sha: 'abc', size: 1234 } }];
const ev = buildEvent({ post: photoPost, text: buildText(photoPost), uploads, thread: { rootId: 'r', parentId: 'p' }, pubkey: 'pk' });
assert.equal(ev.content, 'Live every Friday & stay free https://thereckoning.tv\nhttps://blossom.primal.net/abc.jpg');
assert.deepEqual(ev.tags[0], ['imeta', 'url https://blossom.primal.net/abc.jpg', 'm image/jpeg', 'x abc', 'size 1234', 'dim 1080x1350', 'alt The plumb line']);
assert.ok(ev.tags.some((t) => t[0] === 'e' && t[3] === 'root'));
assert.ok(ev.tags.some((t) => t[0] === 'e' && t[3] === 'reply'));
assert.equal(ev.created_at, 1792065600);

// 6. Mentions: mapped @handles become nostr:npub mentions with p tags; others and handles in links stay as they are
const ERIK = 'bd9eb657c25b4f6cda68871ce26259d1f9bc62420487e3224905b674a710a45a';
const WALKER = 'c48e29f04b482cc01ca1f9ef8c86ef8318c059e0e9353235162f080f26e14c11';
const M = { erikcason: ERIK, walkeramerica: WALKER };
const NE = 'nostr:npub1hk0tv47ztd8kekngsuwwycje68umccjzqjr7xgjfqkm8ffcs53dqvv20pf';
const NW = 'nostr:npub1cj8znuztfqkvq89pl8hceph0svvvqk0qay6nydgk9uyq7fhpfsgsqwrz4u';
assert.equal(linkMentions('Live with @ErikCason and @WALKERAMERICA, @ErikCason again.', M).text, `Live with ${NE} and ${NW}, ${NE} again.`);
assert.deepEqual(linkMentions('@ErikCason @erikcason', M).pubkeys, [ERIK]);
assert.equal(linkMentions('@ErikCasonX @someoneelse https://medium.com/@erikcason erik@ErikCason.com', M).text, '@ErikCasonX @someoneelse https://medium.com/@erikcason erik@ErikCason.com');
const mev = buildEvent({ post: photoPost, text: 'Tune in, @WalkerAmerica!', uploads: [], pubkey: 'pk', mentions: M });
assert.equal(mev.content, `Tune in, ${NW}!`);
assert.deepEqual(mev.tags.filter((t) => t[0] === 'p'), [['p', WALKER]]);

console.log('All transform checks passed.');
