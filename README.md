# The Reckoning: X → Nostr mirror

Every 15 minutes, GitHub Actions checks [@TheReckoning21](https://x.com/TheReckoning21) on X for new posts and republishes each one to Nostr, word for word, signed with The Reckoning's Nostr key:

`npub1zr37347dsh7ezyc5nyu8yrncrlsafsxu9l6canrhlv23z053vvwsk3gyxh`

Copied from the Carla Botcoin mirror (`wclanker/carlabotcoin-nostr-mirror`); the code is the same, only the account differs.

## What gets mirrored

- **Text**: exactly as posted, including long posts. X's `t.co` short links are swapped back to the real URLs.
- **Images and videos**: downloaded at full quality from X and re-uploaded to Nostr media hosting (Blossom, `blossom.primal.net`), so they show inline in Nostr apps. If re-hosting fails, the note links to the X copy instead.
- **Threads**: when the account replies to its own post, the Nostr copy is threaded under the earlier note.
- **Quote posts**: the text plus a link to the quoted post.
- **@mentions of the hosts**: `@ErikCason` and `@WalkerAmerica` (any capitalisation) become real Nostr mentions (`nostr:npub…` plus a `p` tag), so they show as linked names in Primal and the hosts get notified. The handles and npubs live in `mentions.json`; add a line there to link anyone else. Other @handles, and handles inside links, are left as plain text.
- **Skipped**: replies to other people and reposts of other people's posts (turn on with the variables below).
- **Not mirrored**: edits or deletions made on X after a post was copied.
- **Timestamps**: each note is stamped with the time it's published to Nostr, not the original X time, because Primal doesn't index backdated notes. (`KEEP_ORIGINAL_TIME=true` overrides this; don't use it.)

The first run copies nothing. It just marks where the timeline is; everything posted after that is mirrored.

Notes go to `wss://relay.primal.net`, `wss://relay.damus.io` and `wss://nos.lol`.

## Setup

1. **Secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `X` = the X API Bearer Token (the same developer app as the Carla mirror; it can read any public account)
   - `NOSTR` = The Reckoning's `nsec1…`

   Secrets are encrypted and never printed in logs, even though the repo is public. Never paste them anywhere else.
2. **Actions → Mirror X to Nostr → Run workflow** once. That's the baseline run. The log's first line shows the npub it signs as; it should match the one above. From then on it runs itself.

The X handle is set directly in `.github/workflows/mirror.yml` (`X_USERNAME: TheReckoning21`).

## Copying older posts

Actions → Mirror X to Nostr → Run workflow, then paste one or more X post links (comma-separated) into the box. Tick **repost** to post one again (the earlier Nostr copy is deleted). Manual copies don't move the starting point for the scheduled runs.

After any copy, check that Primal has indexed the note (not just the relays) by querying its cache at `wss://cache2.primal.net/v1`, or by opening the profile in Primal.

## Optional settings (Settings → Secrets and variables → Actions → Variables)

| Variable | Default | Meaning |
|---|---|---|
| `NOSTR_RELAYS` | `wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net` | Relays to publish to |
| `BLOSSOM_SERVERS` | `https://blossom.primal.net` | Media hosts to try, in order |
| `MIRROR_REPLIES` | `false` | `true` also mirrors replies to other people |
| `MIRROR_RETWEETS` | `false` | `true` also mirrors reposts |
| `BACKFILL` | `0` | On the first run only, also copy this many recent posts (max 100) |

## Cost

- **X API**: pay-per-use, about $0.005 per new post read and nothing when there's nothing new.
- **GitHub Actions**: free, because the repo is public. If it's ever made private, change the schedule in `mirror.yml` to every 30 minutes.
- **Nostr**: free.

## Checking it

- Each run's log (Actions tab) lists what was mirrored, with the Nostr note ID.
- `state.json` records the last mirrored post and the X-to-Nostr ID map for threading; the workflow commits it after each run. Don't edit it unless you mean to re-copy or skip posts.
- Test without publishing: `npm test`, or `DRY_RUN=true X_BEARER_TOKEN=… node mirror.mjs` to print the notes it would post.
