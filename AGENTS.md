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
- `retrieval/` embeddings in a worker (transformers.js), Unicode tokenizer + MiniSearch keyword index, RRF hybrid search, law stand-in, definitions sheet
- `quality/` pure scorers over saved runs, golden thresholds, repeat-run comparison, regression config and score history (no UI imports)
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
- Concurrency is `VITE_CONCURRENCY` (default 3) inside `executeTasks`, with one claim per task per round and one shared backoff gate so concurrent workers pause together after `http_429` / network / `http_5xx`.
- Show "AI-assisted, requires lawyer review" on all outputs (later prompts).

## Pages (dev)
- `/` the Prompt 1 task test page
- `/?page=ingest` the ingestion page (upload PDF, OCR language, Start/resume, Recheck, review, chunks)
- `/?page=search` embedding progress, hybrid document search, law stand-in search, definitions sheet
- `/?page=analysis` clause analysis, verification, roll-up, cross-clause pass, ledger, metrics, Ask (retrieval / whole-document), custom prompt, restore, forced-failure and fallback checks
- `/?page=quality` quality suite: per-document scores, thresholds, hold-outs, misses/drops, repeat-run comparison, regression set and stored score changes
- Ingestion: a page is Ready only when every page is native/ocr/accepted/blank and chunks are saved. Decisions in `ocr_decisions` win over reprocessing.
- Chunking: top-level clauses must continue the numeric sequence (`N)` primarily, `N.` legacy). `(a)`, `(i)`, `a)`, `(N)` stay inside the clause. Lettered recitals continue A..Z with one restart allowed. Table rows are never boundaries (Sr./no. headers, numbered name/amount rows, bare `N text`).
- `checkChunks` (shown as the "Chunk check" panel) reports page gaps/overlaps, above-max chunks, bad starts, missing/repeated clauses and size-only clause splits.
- Golden test: `tests/golden/hiramoti.test.ts` reads `HIRAMOTI_PDF` (or a known local path) and skips if the PDF is absent.
- Golden scoring: every `tests/golden/<doc>.json` is read by the quality page in the `{doc, holdout, note, expected:[{clause, token, kind, contains?, reason?}], removed:[...]}` format. `kind` is `payment`, `date`, `obligation`, `favour` or `risk`. A file with `"holdout": true` is scored but excluded from the tuning aggregate. A bare clause matches its sub-items; a sub-item expectation needs the same sub-item.
- Quality scorer: pure functions in `src/quality/` read saved `analysis_reports` and stored pages, never call a model, and report recall (model and model+code for payments), precision on listed items, quote validity against the cited page, false "missing" claims, ledger-versus-task counts and overview figure fidelity. Favour recall uses the judgement snapshot attached to a saved report. Scores are kept in localStorage and compared with the previous stored run.
- Repeat-run comparison runs the analysis twice on one document and reports matching verified items plus items seen in only one run.
- The planted-fact tool (`scripts/plant_facts.py`) writes a synthetic text PDF and a matching golden file; `tests/golden/planted.test.ts` checks the facts are on the recorded pages and scores it without a model call.
- Embeddings: `Xenova/multilingual-e5-small` q8, version `...@q8-v1`, `passage:` for chunks, `query:` for questions, windows ≤400 tokens pointing at a parent chunk. Vectors store model + modelVersion + prepFingerprint; a mismatch re-embeds.
- Definitions use a non-reasoning model: set `VITE_SEARCH_MODEL` (e.g. `openai/gpt-4o-mini`). Reasoning models can spend the whole output budget on reasoning and return no JSON; that now fails as `empty_output` instead of splitting.
- Analysis runs on separate small chunks (~700 target / 1200 max tokens) with `[[pN]]` page markers. Quotes are located on the cited page, then the chunk range, then the whole document; page/clause are taken from where they are found, and page corrections are counted.
- Clauses with no model entry are listed as skipped and retried once with a clause-only input. Judgement (whole-document Ask) uses the same resolver and one focused retry for chunks with no finding.
- Judgement directions are `favours_a` / `favours_b` / `neutral`, where A and B are the two agreement parties in definitions-sheet order. Party names come from the sheet, never from fixed text. Any clause with lettered or roman sub-items is packed into small sub-item groups and checked on its own. A burden on a party is never reported as a benefit to that party; obvious cases are reclassified as neutral.
- Document type: one classification call stores `agreement` / `lease` / `deed` / `notice` / `other` on the document (`docType`). It only chooses an extra prompt checklist; unknown or `other` uses the general checklist.
- Chunker numbering: `N.`, `N.N`, `N.N.N`, `N)`, `(N)`, `Clause N`, `Section N`, `Article IV` and `ARTICLE N: TITLE` are detected by the sequence rule (the next number continues the previous). `(N)` and `Section N` also appear as lists, so in a document that uses dotted or paren clauses they must continue a run of the same style. Table rows and numbered lists inside a clause are never boundaries.
- Anchors: sub-item labels follow their own sequence (a..z, then aa, bb, ...), and a unit with no clause number of its own keeps the preceding clause as its prefix.
- Analysis uses `VITE_ANALYSIS_MODEL` (fallback `VITE_SEARCH_MODEL`, then `VITE_MODEL`), reasoning minimal. Prices per 1M tokens: `VITE_PRICE_INPUT_PER_M` / `VITE_PRICE_OUTPUT_PER_M`. Budget starts at 2600 and is replaced by ~1.5× the measured p95 completion tokens after a run.
- Every quoted item is verified against the cited stored page (whitespace/quote/dash/hyphen normalised). Unverified items are dropped and counted, never shown. Roll-up sentences must cite a valid item ID or they are dropped.
- The report is saved to `reports` (Supabase) and `analysis_reports` (IndexedDB); with local state cleared, the page restores it from Supabase.
- `VITE_FALLBACK_MODEL` is used by the fallback check (three forced transient failures, then the fallback on attempt 4).

## Commands
- `npm run dev` the SPA
- `npm test` unit tests (runTask with fake-indexeddb, chunker, page quality, OCR output check)
- `python3 tests/fixtures/make_fixtures.py` regenerates test PDFs (scanned30.pdf is gitignored)
- `python3 scripts/plant_facts.py --out tests/fixtures/planted.pdf --golden tests/golden/planted.json` regenerates the planted-fact PDF and golden file (synthetic text only; add `--seed`, `--pages`, `--facts`)
- `npx supabase start`, then `npx supabase functions serve ai-proxy --env-file supabase/functions/.env`
