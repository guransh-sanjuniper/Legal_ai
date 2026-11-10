# AGENTS.md

Throwaway test harness for a large-document (500-1000 page) legal AI pipeline. Read these first:
- `docs/legal-app-pipeline-context.md` (architecture, task rules, decisions)
- `docs/pipeline-harness-context.md` (harness plan)

## Stack
- React + Vite SPA (`src/`), TypeScript
- Browser IndexedDB via `idb` (documents with PDF Blob, pages, chunks, embeddings, tasks, raw_responses, ocr_decisions, run_state)
- Supabase (local CLI + Docker): Postgres, Auth, Edge Functions. RLS off (throwaway).
- OpenRouter via the `ai-proxy` Edge Function. The key lives in `supabase/functions/.env`, never in the browser.
- Default model: `deepseek/deepseek-v4.1-flash`.

## Folders (under `src/`)
- `ingest/` pdf.js extraction, page quality, Tesseract OCR, OCR output check, clause chunker, fingerprints, storage check. `ingest.worker.ts` runs the pipeline off the main thread.
- `runner/` IndexedDB layer, `runTask`, worker, client (plain TS, no UI imports)
- `tasks/` task types, fingerprint, parse, split, validation
- `retrieval/` local search (not built yet)
- `ui/` React pages only

## Tables
Supabase: `runs`, `task_results`, `reports`, `rate_limits`. RPCs: `save_task_result(p_row jsonb)`, `increment_rate_limit(p_user, p_window)`.
IndexedDB (`pipeline-harness`): `documents`, `pages`, `chunks`, `embeddings`, `tasks`, `raw_responses`, `ocr_decisions`, `run_state`.

## Key rules
- `runTask` is plain TypeScript. No DOM, no Edge APIs.
- Save the raw response to IndexedDB before parsing it.
- Each JSON item is validated separately. Valid items are kept.
- `finish_reason=length` never accepts the output. The piece is split into `${id}/a` and `${id}/b`.
- A stream with no `finish_reason` is `stream_interrupted`, never parsed.
- A task is `done` only after `save_task_result` succeeds.
- Idempotency: `task_results` is unique on `(task_id, fingerprint)`. The fingerprint excludes the model.
- Each attempt has an `attempt_id`. Results from superseded attempts are dropped.
- Retry only: `timeout`, `network`, `stream_interrupted`, `bad_json`, `validation`, `http_429`, `http_5xx`. Max 3 retries, then the fallback model on the last attempt.
- `http_401`, `http_400`, `http_403` and `length` at the minimum size fail immediately.
- A task found in `requesting` on startup becomes `uncertain` and gets one new call.
- A task in `received` with a saved raw response is parsed and saved again with no new AI call.
- Supabase `runs.status` is authoritative. If Supabase is unreachable, the runner pauses, not fails.
- One runner per document, enforced by `navigator.locks` (`doc:<docHash>`, `ifAvailable`).
- Concurrency 2.
- Show "AI-assisted, requires lawyer review" on all outputs (later prompts).

## Pages (dev)
- `/` the Prompt 1 task test page
- `/?page=ingest` the ingestion page (upload PDF, OCR language, Start/resume, Recheck, review, chunks)
- Ingestion: a page is Ready only when every page is native/ocr/accepted/blank and chunks are saved. Decisions in `ocr_decisions` win over reprocessing.

## Commands
- `npm run dev` the SPA
- `npm test` unit tests (runTask with fake-indexeddb, chunker, page quality, OCR output check)
- `python3 tests/fixtures/make_fixtures.py` regenerates test PDFs (scanned30.pdf is gitignored)
- `npx supabase start`, then `npx supabase functions serve ai-proxy --env-file supabase/functions/.env`
