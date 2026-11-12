# Hosted Supabase

The app shell runs against the hosted Supabase project. Local Supabase keeps working
unchanged. The switch is a Vite mode: `npm run dev` reads `.env.local`, `npm run dev:hosted`
reads `.env.hosted` (and the same for `build:hosted`).

## 1. Link the project

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
```

`<project-ref>` is the short id in the dashboard URL (`https://supabase.com/dashboard/project/<ref>`).
The CLI asks for the database password once.

## 2. Push the migrations

```bash
npx supabase db push
```

This applies `supabase/migrations/0001_foundation.sql`, `0002_failure_message.sql` and
`0003_rate_limit_and_pause.sql` (tables `runs`, `task_results`, `reports`, `rate_limits`,
and the `save_task_result` / `increment_rate_limit` / `admit_rate_limit` functions).

## 3. Set the Edge Function secrets

`supabase/functions/.env` is gitignored and already holds the local values. The same file
can be pushed to the hosted project:

```bash
npx supabase secrets set --env-file supabase/functions/.env
```

Optional values:

| Variable | Meaning |
|---|---|
| `OPENROUTER_API_KEY` | Required. The key never reaches the browser. |
| `RATE_LIMIT_PER_MIN` | Optional. Per-user limit, default 40. |
| `ALLOWED_ORIGIN` | Optional. Comma-separated browser origins. Unset means any origin. |

The `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` values are injected by the platform.

## 4. Deploy the proxy

```bash
npx supabase functions deploy ai-proxy
```

The function verifies the caller's user token with `admin.auth.getUser`, so the default
JWT verification is fine. If the hosted gateway rejects the project's ES256 token before
the function runs, redeploy with `--no-verify-jwt`; the function still authenticates the
caller itself.

## 5. Create the first user

Dashboard → Authentication → Users → Add user. Set the email and password and confirm the
user. The app has no self-service sign-up.

## 6. Point the app at the hosted project

```bash
cp .env.hosted.example .env.hosted
# fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev:hosted
```

`.env.hosted` is gitignored. The anon key is the public key; it is safe in the browser but
still never committed. Both commands run the pdf.js asset copy first, so `/wasm/`,
`/cmaps/` and `/standard_fonts/` are present.

## 7. Smoke test

```bash
# 1. Get a user token (password grant).
TOKEN=$(curl -s -X POST "https://<ref>.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: <anon-key>" -H "content-type: application/json" \
  -d '{"email":"<user-email>","password":"<password>"}' | jq -r .access_token)

# 2. A valid token streams NDJSON. Expect {"t":"d"...} and then {"t":"end"...}.
curl -s -X POST "https://<ref>.supabase.co/functions/v1/ai-proxy" \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"model":"deepseek/deepseek-v4.1-flash","messages":[{"role":"user","content":"Say OK"}],"max_tokens":16}'

# 3. A wrong token must return 401.
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://<ref>.supabase.co/functions/v1/ai-proxy" \
  -H "authorization: Bearer invalid" -H "content-type: application/json" \
  -d '{"model":"deepseek/deepseek-v4.1-flash","messages":[{"role":"user","content":"Say OK"}],"max_tokens":16}'

# 4. Browser preflight must return 204 with an allow-origin header.
curl -s -i -X OPTIONS "https://<ref>.supabase.co/functions/v1/ai-proxy" \
  -H "origin: http://localhost:5173" \
  -H "access-control-request-method: POST" \
  -H "access-control-request-headers: authorization,content-type" | head -20
```

In the browser: sign in at `/`, open a document, then use the sidebar's "Dev: pipeline pages"
link to run one analysis call. The app shell and the harness pages share the same persisted
session.

## Static hosting

`npm run build:hosted` writes `dist/`. The app shell uses client-side routes (`/chat`,
`/documents`, `/analysis/:docId`, `/draft`, `/compare`), so the static host must rewrite
unknown paths to `index.html` (SPA fallback). The harness pages use `/?page=...` and work
with the same rewrite.

## Local vs hosted

| Mode | Command | Environment file |
|---|---|---|
| Local | `npm run dev` | `.env.local` |
| Hosted | `npm run dev:hosted` | `.env.hosted` |
| Local build | `npm run build` | `.env.local` |
| Hosted build | `npm run build:hosted` | `.env.hosted` |

Local Supabase keeps running with `npx supabase start` and
`npx supabase functions serve ai-proxy --env-file supabase/functions/.env`.

## Before real client data

The hosted tables have row-level security off. The anon key is public, so anyone holding
it can read `runs`, `task_results` and `reports`. That is a schema change, not a UI change,
and should be done before the app is used with real client documents. The PDFs and page
text stay in the browser's IndexedDB and are never uploaded to Supabase.
