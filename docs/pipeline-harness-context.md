# Pipeline Test Harness (v2, browser-local): Context and 3-Hour Build Plan

Use with `legal-app-pipeline-context.md` (v2), which is the source of truth for architecture, task rules, and decisions. This file defines the throwaway harness that proves the pipeline before the full app. **Full scope, no cuts. Steps are merged into 5 prompts.**

## Aim, goal, scope
Prove, on real 500-1000 page documents, that (1) ingestion, runner, and results sync are reliable and resumable, and (2) analysis, retrieval and Q&A are correct across the **whole** document. Scope: IndexedDB storage, extraction, OCR + page review, chunking, embeddings + local hybrid search, AI proxy, browser runner, clause analysis, roll-up, cross-clause pass, coverage ledger, quote verification, custom-prompt job, Ask box, results saved to Supabase and restored, progress/metrics page, quality suite. Out: auth/RLS (throwaway project), polished UI, Comparator, Drafter, DOCX.

## Fixed decisions
SPA (React + Vite). Data in IndexedDB; results in Supabase (throwaway project, RLS off). Browser runner in a worker, outside UI components, Web Lock per document. Stateless Edge Function proxy holds the OpenRouter key. `runTask` is plain TypeScript. No pg_cron, no server queue, no hosted worker. Folders: `ingest/ runner/ tasks/ retrieval/ ui/`. Keep `AGENTS.md` (stack, table names, key rules). Commit after each passing prompt. One new opencode session per prompt. Model: a cheap fast coding model for most prompts, a stronger one for runner/idempotency bugs. Explain every change; no blind fixes.

## Schedule (3 hours)
| Time | Prompt |
|---|---|
| 0:00-0:35 | P1 Foundation |
| 0:35-1:15 | P2 Ingestion |
| 1:15-1:50 | P3 Search |
| 1:50-2:35 | P4 Analysis + UI |
| 2:35-3:00 | P5 Quality suite, then start the 1000-page run |

Code can be generated in about 3 hours. Verification cannot be compressed: the 1000-page run (about 25-45 min per 500 pages), interruption tests, and fix prompts (expect 3-5) come after.

## Prompts

### P1: Foundation (storage + proxy + runner)
Build: (a) IndexedDB layer (documents with PDF Blob, pages, chunks, embeddings, tasks, OCR decisions, run state). (b) Supabase migration: `runs`, `task_results` (unique idempotency key = task_id + fingerprint), `reports`, with failure fields. (c) Edge Function `ai-proxy`: verifies login token, adds OpenRouter key, 100s timeout, streams, returns provider, finish_reason, token usage; per-user rate limit. (d) `runTask(db, task, cfg)` in plain TypeScript: budgets output tokens, saves **raw response locally first**, validates each JSON item separately, splits the piece on `finish_reason=length`, records failure code/finish reason/provider/tokens/duration, fences by attempt ID, saves to Supabase with the idempotency key, marks lost requests `uncertain`. (e) Runner worker: Web Lock per document, small concurrency, max 3 retries with backoff and fallback model, resume that reuses saved results, authoritative run status from Supabase.
**Done when:** a hand-made task runs end to end; wrong key gives `http_401`; tiny `max_tokens` splits into two children; tiny timeout gives `timeout`; killing the tab mid-task then reopening resumes with no duplicate result row; a second tab is blocked.

### P2: Ingestion (extract + OCR + chunk)
Build: pdf.js in a Web Worker, page by page, physical page numbers, incremental save and resume; text-quality + image checks per page; Tesseract.js (eng/mar/hin) with per-document language, 200 DPI and 300 DPI retry; page review UI (compare image and text, correct, confirm blank, leave unresolved), corrections preserved on recheck; Ready only when all pages resolved; clause-aware chunking (page range, clause number, heading, about 3-8k tokens, overlap); document hash + preparation fingerprint; `navigator.storage.persist()` and quota warning; progress shown.
**Done when:** a 10-page PDF matches page text; closing at page 5 and reopening resumes without duplicates; a scanned PDF's empty pages are detected, wrong-language output is flagged, corrections survive a recheck; clause numbers and page ranges match a known contract, no chunk cut mid-clause.

### P3: Search (embeddings + local hybrid + definitions)
Build: multilingual embedding model in a worker (pinned version, stored with chunks), local keyword index with a Marathi/Hindi-safe tokenizer, hybrid search (vector + keyword, optional rerank) returning chunk, page, clause; a small stand-in law library (about 20 passages) searched the same way; the definitions-sheet task (parties, defined terms, dates) stored and attachable to every task.
**Done when:** a phrase known to be on a page ranks that chunk near the top, in English and in Marathi/Hindi; the law stand-in returns the right passage for 5 test clauses; a 1000-page document embeds without a crash (record time).

### P4: Analysis + UI
Build: clause analysis tasks (JSON: type, parties, obligations, dates with timing type fixed/event-relative/none, payments, risks, law passages attached); roll-up (section summaries, overview, multi-level if needed); cross-clause pass (contradictions, gaps, payment totals) with a whole-document search before any "missing" claim; code-side verification (quote exists on cited page, IDs valid, unverified sentences dropped); coverage ledger (processed/analysed/verified per clause, saved with the report); custom-prompt job (any prompt per clause, then merge); Ask box with two modes (retrieval answer, whole-document answer) showing retrieved chunks and citations or "not found"; results and reports synced to Supabase and restored after reload; progress/metrics page (progress bar, p95 duration, retried/split/failed counts, failed-task table, tokens, cost estimate, log).
**Done when:** ledger counts equal real `done` results; every quote verifies; "list all payment dates" matches a manual count; the overview mentions items visible in the clause JSON; reload restores the report; a forced failure shows in the table.

### P5: Quality suite
Build: planted-fact script (insert known items at known pages into a test PDF), scoring (recall, precision, citation validity, false "missing" claims, roll-up fidelity), repeat-run comparison, lawyer-marked question set loader, one metrics report page, fixed regression set (10, 200, 1000 pages).
**Done when:** the report lists planted facts found/missed and flags a deliberately wrong fact.

## Metrics and pass criteria
Reliability: pages saved = PDF pages; no task left queued/running; failed under 1-2%; p95 task time well under 100s; retries/splits low and all end `done`; every chunk has exactly one finished result; no browser crash on 1000 pages; interruption tests (close tab mid-ingestion, mid-analysis, sleep laptop, kill a request) all resume without duplicates or lost pages; uncertain tasks few and recoverable. Quality: high planted-fact recall, 100% citation validity, no false "missing", ledger matches reality, stable repeat runs. Use the production model for quality runs, a cheap one for reliability. Score separately.

## Test files
Real 500-1000 page text PDF; scanned PDF; mixed Marathi/Hindi PDF; messy numbering/cross-references; regression set with planted facts.

## Decision gate
Reliability and recall pass: build the full app. Recall low: fix chunking/context/prompts. Ingestion or storage fails: reduce memory use, change embedding approach, add persistence handling. Proxy or runner fails: shrink tasks and concurrency first; only then consider a server runner.
