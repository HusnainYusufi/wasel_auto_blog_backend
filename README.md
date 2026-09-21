# Wasel Auto Blog — Backend

NestJS API that turns a topic plus a few configuration knobs into a publish-ready,
SEO-optimized article with original imagery, using the **MiniMax** API.

## Pipeline

Each generation runs five stages and streams progress over SSE:

| # | Stage | What happens |
|---|-------|--------------|
| 1 | **Blueprint** | MiniMax plans title, slug, meta tags, search intent, keyword map, non-repetitive section outline, FAQ, and per-image art direction — returned as JSON. |
| 2 | **Draft** | The full article is written in Markdown against that outline, with `[[IMAGE_n]]` placeholders positioned inside the relevant sections. |
| 3 | **Imagery** | `image-01` renders a hero plus in-body visuals (2 at a time). MiniMax image URLs expire after 24h, so every file is downloaded into `uploads/` and re-served from this API. |
| 4 | **SEO audit** | The finished draft is scored, tagged, and given social copy and ranking suggestions. |
| 5 | **Assemble** | Table of contents, keyword density, JSON-LD structured data, HTML rendering, and exports. |

A failed image never fails the article — its placeholder is simply dropped.

## Keyword sets

Reusable, named groups of target keywords. Pick one or more in the studio and their
keywords are merged into the generation — typed keywords come first, then the sets', all
de-duplicated case-insensitively and capped at 50.

Sets are ordered pinned → most-used → newest, and `useCount` is bumped on each generation
so the picker surfaces what you actually reach for. Keywords are stored verbatim, so
Arabic and other non-Latin terms survive round-tripping unchanged.

`prisma/seed.ts` ships one starter set (Arabic mattress keywords); existing sets are never
overwritten.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/keyword-sets` | All sets, pinned first. |
| `POST` | `/api/keyword-sets` | Create. `keywords` accepts an array or a newline/comma blob. |
| `PATCH` | `/api/keyword-sets/:id` | Partial update, including `pinned`. |
| `DELETE` | `/api/keyword-sets/:id` | Delete (`admin`). |

Pass `keywordSetIds` on a generation request to apply them.

## Non-Latin languages

Arabic (and any non-Latin script) is supported end to end, with two things handled
explicitly:

- **Slugs** are transliterated, not stripped. `slugify` previously removed every non-Latin
  character, so every Arabic title produced the slug `untitled`. Arabic now maps to ASCII
  (`افضل مراتب السرير` → `afdl-mratb-sryr`) via
  [`transliterate.util.ts`](src/common/transliterate.util.ts), with the definite article
  dropped. Because transliteration can map two distinct titles onto one slug
  (`مراتب السرير` and `مراتب سرير` both give `mratb-sryr`), slugs are made unique with a
  counter suffix at save time.
- **The table of contents** is assembled in code after generation, so its heading is
  localised per language rather than left as English in an Arabic article.

Word counting and keyword density already worked on Arabic — density is measured by
substring occurrence, which is script-agnostic.

## Text providers

Text generation runs through a provider abstraction, so an article can be written by
**MiniMax** or **Google Gemini**. The engine is selectable per generation in the studio's
advanced controls, and the choice is stored on the article. Imagery is always MiniMax
`image-01` — Gemini's image models are a separate API and are not wired up.

| | MiniMax | Gemini |
|---|---|---|
| Endpoint | `/v1/chat/completions` (OpenAI-shaped) | `/v1beta/models/{model}:generateContent` |
| Auth | `Authorization: Bearer` | `X-goog-api-key` header |
| System prompt | a `system` message | dedicated `systemInstruction` field |
| JSON output | prompted, with a corrective retry | native `responseMimeType: application/json` |
| Key | `MINIMAX_API_KEY` | `GEMINI_API_KEY` |

`TEXT_PROVIDER` sets the default when a request does not name one. A provider with no key
is advertised as unconfigured and refuses requests up front, before a row is written.

Model ids are unique across providers, so a stored `textModel` is enough to route a later
regeneration. Sending a model that belongs to another provider corrects the provider rather
than silently swapping in the wrong model.

Adding a third provider means implementing [`TextProvider`](src/providers/text-provider.interface.ts)
and registering it in [`TextProviderRegistry`](src/providers/text-provider.registry.ts) —
the pipeline itself needs no changes.

### Gemini notes

- Reasoning arrives as extra `parts` carrying `thought` / `thoughtSignature`. Those are
  stripped before assembly, so traces never reach the article or the JSON parser.
- `finishReason: MAX_TOKENS` with no text means the budget went entirely to reasoning;
  that surfaces as a clear error rather than an empty article.
- A blocked prompt (`promptFeedback.blockReason`) and a `SAFETY` finish are reported
  distinctly from transport failures.

## Authentication

Every `/api` route requires a bearer token. The exceptions are `/health`, the SSE progress
stream and the export endpoints — a browser `EventSource` and an `<a href>` download cannot
attach an Authorization header, and neither route leaks article content beyond what the
holder of the id already has.

**There is no signup route.** The first account is created by the seed script:

```bash
# set SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD in .env first
npm run seed
```

Re-running is safe — an existing account is left alone unless
`SUPERADMIN_RESET_PASSWORD=true`, which resets the password and ends every session.

How the tokens work:

- **Access token** — 15 minutes, carries `sub`, `role`, and a `tv` token version.
- **Refresh token** — 7 days, stored only as a SHA-256 hash, one row per issue.
- **Rotation** — every refresh revokes the old row and links its replacement.
- **Reuse detection** — presenting an already-rotated token means it leaked, so the entire
  token family is revoked and the holder must sign in again.
- **Instant revocation** — a password change or `logout-all` bumps `tokenVersion`, which
  invalidates outstanding *access* tokens too, not just refresh tokens.
- **Login throttling** — 5 attempts per minute per IP, and a wrong email costs the same
  time as a wrong password so valid addresses cannot be probed.
- Passwords are bcrypt with cost 12.

Roles are `superadmin` > `admin` > `editor`; a higher role satisfies any lower requirement.
Deleting articles and clearing the knowledge base require `admin`.

## Review workflow

A finished article lands in the queue as `pending`. It can then be **approved** (kept) or
**rejected**, each with an optional note, and a decided article can be **reopened**. Every
transition — plus generation start, completion, and failure — is written to `BlogAuditLog`
and shown as a history timeline on the article.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/blogs/:id/approve` | Keep it. Optional `{ note }`. |
| `POST` | `/api/blogs/:id/reject` | Reject it. Optional `{ note }`. |
| `POST` | `/api/blogs/:id/reopen` | Send back to the pending queue. |
| `GET` | `/api/blogs/:id/history` | Full audit trail with actor and timestamps. |

`GET /api/blogs` accepts `reviewStatus=pending|approved|rejected` and returns
`reviewCounts` alongside the results.

## Knowledge base

Point the app at blogs you have already published. It crawls them, extracts the article
text, and derives a profile of your niche — house style, recurring themes, ground already
covered, and the gaps worth filling next.

When **Write in my blog's voice** is enabled on a generation, that profile is injected into
the planning and writing stages, so the new article matches your established voice, avoids
re-covering old ground, and links to your real posts.

Internal links are placed in two steps: a dedicated model call picks anchor phrases that
already exist verbatim in the draft, then [`applyInternalLinks`](src/blog/blog.service.ts)
inserts them in code. Asking the writer to place links inline was unreliable — it either
ignored the instruction or invented URLs. The prompt requires a stated reason per link and
prefers one strong link over several weak ones.

## Setup

```bash
npm install
cp .env.example .env        # then add your MINIMAX_API_KEY
npm run setup               # prisma generate + db push + seed the superadmin
npm run start:dev
```

The API listens on **http://localhost:3332/api**. Verify with:

```bash
curl http://localhost:3332/health
# { "status": "ok", "minimaxConfigured": true, ... }
```

If `minimaxConfigured` is `false`, the key is missing or still the placeholder.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `MINIMAX_API_KEY` | — | **Required.** From MiniMax → Account Management → API Keys. |
| `MINIMAX_BASE_URL` | `https://api.minimax.io/v1` | Use the region endpoint that matches your account. |
| `MINIMAX_TEXT_MODEL` | `MiniMax-M2.5` | Any of M3 / M2.7 / M2.5 / M2.1 / M2 (± `-highspeed`). |
| `MINIMAX_IMAGE_MODEL` | `image-01` | Image model. |
| `GEMINI_API_KEY` | — | Optional. From https://aistudio.google.com/apikey |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | Gemini API base. |
| `GEMINI_TEXT_MODEL` | `gemini-flash-latest` | Default Gemini model. |
| `TEXT_PROVIDER` | `minimax` | Default engine: `minimax` or `gemini`. |
| `PORT` | `3332` | API port. |
| `CORS_ORIGIN` | `http://localhost:3211` | Comma-separated allowed origins. |
| `PUBLIC_URL` | `http://localhost:3332` | Base URL used to build stored image links. |
| `DATABASE_URL` | `file:./dev.db` | SQLite by default. |
| `JWT_ACCESS_SECRET` | — | **Required in production.** `openssl rand -hex 48`. |
| `JWT_REFRESH_SECRET` | — | **Required in production.** Must differ from the access secret. |
| `JWT_ACCESS_TTL` | `15m` | Access token lifetime. |
| `JWT_REFRESH_TTL` | `7d` | Refresh token lifetime. |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | — | Used by `npm run seed` only. |

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service and MiniMax configuration status. |
| `POST` | `/api/auth/login` | Returns access + refresh tokens. Throttled. |
| `POST` | `/api/auth/refresh` | Rotates the refresh token. |
| `POST` | `/api/auth/logout` | Revokes the presented token's family. |
| `POST` | `/api/auth/logout-all` | Ends every session for the current user. |
| `GET` | `/api/auth/me` | Current user. |
| `POST` | `/api/auth/change-password` | Requires the current password; ends all sessions. |
| `GET` | `/api/knowledge` | Crawled sources with status counts. |
| `POST` | `/api/knowledge` | Add URLs. `{ urls, discoverLinks, maxPages }` — with `discoverLinks`, each URL is treated as an index and its posts are pulled in. |
| `GET` | `/api/knowledge/profile` | Derived niche, style notes, gaps, and suggested topics. |
| `POST` | `/api/knowledge/profile/rebuild` | Re-analyze the corpus. |
| `POST` | `/api/knowledge/:id/recrawl` | Re-fetch one source. |
| `DELETE` | `/api/knowledge/:id` / `/api/knowledge/all` | Remove one source, or all of them. |
| `GET` | `/api/blogs/options` | Tones, lengths, image styles, aspect ratios, and every text provider with its models and configured flag — drives the frontend form. |
| `POST` | `/api/blogs` | Start a generation. Returns `{ id, status }` immediately. |
| `GET` | `/api/blogs/:id/stream` | **SSE** progress. Replays history, then streams live events. |
| `GET` | `/api/blogs` | List with `search`, `status`, `take`, `skip`. |
| `GET` | `/api/blogs/:id` | Full article, images, SEO pack, and event log. |
| `POST` | `/api/blogs/:id/images/:imageId/regenerate` | Re-render one image and swap it into the body. |
| `GET` | `/api/blogs/:id/export?format=md\|html\|json` | Download. `md` includes YAML front matter; `html` is a standalone styled page with OG tags and JSON-LD. |
| `DELETE` | `/api/blogs/:id` | Delete the article and its stored images. |

### Generation request

Only `topic` is required.

```jsonc
{
  "topic": "How AI voice agents reduce clinic no-shows",
  "keywords": ["ai voice agent", "clinic no-shows"],
  "language": "English",
  "tone": "professional",          // professional | conversational | authoritative | friendly | witty | inspirational | technical | storytelling
  "audience": "clinic operations managers",
  "lengthPreset": "standard",      // brief ~800 | standard ~1500 | indepth ~2400 | pillar ~3200
  "pointOfView": "second-person",
  "brandName": "Wasel",
  "callToAction": "Book a 15-minute demo",
  "imageCount": 3,                 // 0-6 (1 hero + rest in-body)
  "aspectRatio": "16:9",
  "imageStyle": "modern editorial photography",
  "includeFaq": true,
  "includeToc": true,
  "textProvider": "gemini",       // minimax | gemini — omit for the configured default
  "textModel": "gemini-flash-latest",
  "useKnowledgeBase": true,      // write in the voice of your crawled posts
  "knowledgeSourceIds": []       // empty = every ready source
}
```

## Notes

- **Switching to Postgres:** change `provider` in [prisma/schema.prisma](prisma/schema.prisma) to `postgresql`, point `DATABASE_URL` at your instance, and re-run `npm run setup`.
- **Image storage** is local (`uploads/`). For multi-instance deployments, swap [src/storage/storage.service.ts](src/storage/storage.service.ts) for S3 — it is the only place that touches the filesystem.
- **Token storage.** The frontend keeps tokens in `localStorage`, which is readable by any
  script that gets injected into the page. The access token's short life and refresh
  rotation limit the blast radius. Moving to httpOnly cookies would remove that exposure and
  is the right change if this is ever exposed beyond a trusted network.
- **Crawling** only follows `http(s)` and rejects loopback and private-range hosts, so a pasted URL cannot be used to probe your internal network.
- **HTTP layer.** MiniMax calls go through [src/common/http.util.ts](src/common/http.util.ts) (Node's core `http`/`https`) rather than `fetch`. `api.minimax.io` publishes AAAA records, and on IPv4-only networks undici prefers the unroutable IPv6 address and stalls until timeout; `main.ts` also sets `ipv4first` resolution order.
- **Generation is in-process.** For heavy concurrent use, move `BlogService.run()` behind a queue (BullMQ) so restarts don't strand running jobs.
