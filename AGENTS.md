# AGENTS.md

Throwaway test harness for a large-document (500-1000 page) legal AI pipeline. Read these first:
- `docs/legal-app-pipeline-context.md` (architecture, task rules, decisions)
- `docs/pipeline-harness-context.md` (harness plan)

## Stack
- React + Vite SPA (`src/`), TypeScript
- `docx` produces the Word export in the browser; no server build step.
- Browser IndexedDB via `idb` (documents with PDF Blob, pages, chunks, embeddings, tasks, raw_responses, ocr_decisions, run_state)
- Supabase (local CLI + Docker): Postgres, Auth, Edge Functions. RLS off (throwaway).
- Hosted Supabase for the app shell: `npm run dev:hosted` reads `.env.hosted`; local `npm run dev` reads `.env.local`. The `ai-proxy` proxy is the same function in both. See `docs/hosted-supabase.md`.
- OpenRouter via the `ai-proxy` Edge Function. The key lives in `supabase/functions/.env`, never in the browser. The function sends CORS headers for hosted browser preflights; `ALLOWED_ORIGIN` (optional, comma-separated) locks the allowed origin.
- Default model: `deepseek/deepseek-v4.1-flash`.

## Folders (under `src/`)
- `ingest/` pdf.js extraction, page quality, Tesseract OCR, OCR output check, clause chunker, fingerprints, storage check. `ingest.worker.ts` runs the pipeline off the main thread.
- `runner/` IndexedDB layer, `runTask`, worker, client (plain TS, no UI imports)
- `tasks/` task types, fingerprint, parse, split, validation
- `retrieval/` embeddings in a worker (transformers.js), Unicode tokenizer + MiniSearch keyword index, RRF hybrid search, law stand-in, definitions sheet
- `quality/` pure scorers over saved runs, golden thresholds, repeat-run comparison, regression config and score history (no UI imports)
- `ui/` React pages only
- `ui/app/` the app shell: router, sidebar, login gate, theme, placeholders (UI only)
- `ui/library/` document library page, preparation orchestrator, status derivation, ingest-worker wrapper, local removal
- `lib/` shared Supabase client for the app shell (one persisted session per project)

## App shell (routes)
- `/` redirects to `/chat`; the app shell owns the router. The harness pages stay at `/?page=...`.
- `/chat`, `/draft`, `/compare` are placeholders.
- `/documents` lists IndexedDB documents, imports a PDF and runs the whole preparation (ingestion, embeddings, index, definitions), removes a document from this device.
- `/documents/:docId/review` is the in-app review screen (page image beside OCR text, decisions, Retry OCR, Recheck, Proceed without reviewing). Needs-review rows and the Review action open it; the harness page is not linked from the library.
- `/analysis` lists ready documents; `/analysis/:docId` is the Deep Analysis page (Ready documents only, see "Deep Analysis page").
- Status: `ready` → Ready (with "Ready · N pages not reviewed" when pages were waived); `review` → Needs review (N pages); `new`/`processing` → Preparing. The library's Ready is the durable preparation result (see Document preparation); the document-level `status` stays the ingestion status.
- Login: Supabase Auth email+password. The app shell and the harness pages share one persisted session (same project URL, same localStorage key).
- "Remove from this device" deletes the document, pages, chunks, OCR decisions, embeddings, definitions, analysis reports/state, tasks and run state for that document. It refuses while a preparation or analysis lock is held. Supabase reports are kept.
- Theme: light/dark, scoped to the app shell; the harness pages keep their look.

## Document preparation (library)
- "Import PDF" runs the whole preparation in one go: ingestion (extract, OCR, page decisions, chunking), then embeddings, then the keyword-index warm-up, then the definitions sheet. The library is the only orchestrator; the pipeline modules are unchanged.
- The orchestrator lives in `src/ui/library/prepare.ts` outside React. It survives route changes (one preparation per tab), and the per-document `navigator.locks` lock (`doc:<hash>`) still blocks another tab. Progress is written to `localStorage` (`legal-app.prep.<docId>`) and pushed to the library, so navigating away and back keeps the progress live.
- Stages are skipped when their durable result exists: chunks on the document, `embedding_state` with `completedAt` and the matching preparation fingerprint and embedding model version, and a `definitions` record with the matching preparation fingerprint. A document already prepared in the harness (no wrapper state) reaches Ready without re-running those stages.
- The keyword index is derived in the retrieval worker, not persisted. Preparation warms it with a search call; the Search page rebuilds its own index. A document with no definition/party text gets an empty `definitions` record so it can reach Ready.
- `Ready` is the durable preparation result: `doc.status === 'ready'` plus chunks, embeddings and a matching definitions sheet. The document's `status` stays the ingestion status; a ready document with a missing stage is `Preparing`.
- Status: Preparing (stage + progress bar) / Needs review (N pages) / Ready / Failed (stage + reason + Retry). A review document pauses and waits for the user; the review page continues the preparation automatically after the last page decision. A failed stage is retried explicitly; partial definitions (some failed tasks) are treated as failed.
- Proceed without reviewing (library row and review screen, after a confirm): every page still needing review (`status` review, or already waived) gets an `ocr_decisions` row with `decision: 'waived'` holding its extracted text. The page is `accepted` with `source: 'waived'` (so it is never shown as human-confirmed), and an empty page stays empty. Ingestion then finalizes and preparation continues to Ready with no special casing. Pages a person already decided are not touched. The waiver is one IndexedDB transaction (`src/ingest/review.ts`).
- Waived pages stay reviewable. A manual decision replaces the waiver (source `manual`). A recheck keeps every decision, waived included.
- Ready with waived pages shows "Ready · N pages not reviewed" (tooltip on the chip) and a Review action. Failed definitions on such a document follow the normal path (Failed, Retry); no special bypass.
- Resume: a review document with zero unresolved pages (tab closed after Proceed, before finalize) resumes automatically on the next load. A document with unresolved pages still waits for the user.
- `runPreparation` honours `forceIngest` and `recheck` even for a prepared document; the review screen uses that to re-ingest after each decision. Preparation is not started while another document is being prepared in the tab.
- The review screen disables decisions while a preparation runs for the same document (a decision during a run could be skipped by the run's finalize).
- Decisions are shared by the harness page and the review screen (`saveReviewDecision`). The harness page's Retry OCR and the review screen's Retry OCR write the same page; a saved decision still wins on a later recheck (existing behaviour, not changed).
- Analysis reports carry `unreviewedPages` (count of waived pages when the run was saved). The report shows a separate "Pages not reviewed." banner, also in exports. Older reports have no count and show no banner.
- "Retry" re-runs the failed stage; "Remove" deletes the document and its local state. `preparedAt` and the prepared fingerprint (including the embedding model version) are stored on Ready.

## Tables
Supabase: `runs`, `task_results`, `reports`, `rate_limits`. RPCs: `save_task_result(p_row jsonb)`, `increment_rate_limit(p_user, p_window)`.
IndexedDB (`pipeline-harness`): `documents`, `pages`, `chunks`, `embeddings`, `embedding_windows`, `embedding_state`, `definitions`, `analysis_reports`, `analysis_state`, `tasks`, `raw_responses`, `ocr_decisions`, `run_state`.

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
- The proxy returns the provider's error message with `http_4xx`/`http_5xx`; `runTask` stores it as `failureMessage` on the task and `failure_message` on `task_results`, and the failed-task table shows it.
- `http_401`, `http_400`, `http_403` and `length` at the minimum size fail immediately.
- A task found in `requesting` on startup becomes `uncertain` and gets one new call.
- A task in `received` with a saved raw response is parsed and saved again with no new AI call.
- Supabase `runs.status` is authoritative. If Supabase is unreachable, the runner pauses, not fails.
- One runner per document, enforced by `navigator.locks` (`doc:<docHash>`, `ifAvailable`).
- Concurrency is `VITE_CONCURRENCY` (default 3) inside `executeTasks`, with one claim per task per round and one shared backoff gate so concurrent workers pause together after `http_429` / network / `http_5xx`.
- Show "AI-assisted, requires lawyer review" on all outputs (later prompts).

## Pages (dev)
- `/` the app shell (sign-in, Documents, Chat, Deep Analysis, Drafter, Comparator)
- `/chat`, `/documents`, `/analysis`, `/analysis/:docId`, `/draft`, `/compare` the app routes
- `/?page=test` the Prompt 1 task test page
- `/?page=ingest` the ingestion page (upload PDF, OCR language, Start/resume, Recheck, review, chunks). `&doc=<id>` opens a document directly.
- `/?page=search` embedding progress, hybrid document search, law stand-in search, definitions sheet
- `/?page=analysis` clause analysis, verification, roll-up, cross-clause pass, ledger, metrics, Ask (retrieval / whole-document), custom prompt, restore, forced-failure and fallback checks
- `/?page=quality` quality suite: per-document scores, thresholds, hold-outs, misses/drops, repeat-run comparison, regression set and stored score changes
- Ingestion: a page is Ready only when every page is native/ocr/accepted/blank and chunks are saved. Decisions in `ocr_decisions` win over reprocessing (accept, correct, blank, unresolved, waived). The only ingestion change for review work is the `waived` branch in `processPage`; OCR, extraction, chunking and fingerprints are unchanged.
- OCR is multi-pass and document-neutral: 200/300/400 DPI, PSM 3/4/6, and grayscale/Otsu preprocessing; the best attempt is chosen by `checkOcrOutput`, confidence and word count. Page records store confidence, words and PSM for review.
- pdf.js assets: `scripts/copy-pdfjs-assets.mjs` copies `wasm/`, `cmaps/` and `standard_fonts/` from `node_modules/pdfjs-dist` into `public/` on predev/prebuild/pretest. `openPdf` passes `/wasm/`, `/cmaps/` and `/standard_fonts/`; without them CCITT/JBIG2 masks decode to an almost blank page.
- If a rendered page has more than one image object but under 1% ink, the page is marked `render_decode_failed` instead of being OCR'd as a blank page. The review panel and log show a wasm-asset hint.
- Regression tests: `tests/pdfjs-assets.test.ts` checks the wasm/cmap/font routes (wasm as `application/wasm`); `tests/golden/arihant.test.ts` renders a CCITT-mask page and checks real ink (conditional on the attached PDF).
- Chunking: top-level clauses must continue the numeric sequence (`N)` primarily, `N.` legacy). `(a)`, `(i)`, `a)`, `(N)` stay inside the clause. Lettered recitals continue A..Z with one restart allowed. Table rows are never boundaries (Sr./no. headers, numbered name/amount rows, bare `N text`).
- Chunking restarts: a low top-level number after a real run, or a `Schedule`/`Annexure`/`Part`/`Article`/`Chapter` heading or a page-title block, starts a new numbering run and records a section break. A table row never restarts numbering.
- Hard clause limits: `maxClausePages` (15) and `maxClauseTokens` (6000). An over-limit clause is force-closed at the next heading-like line and marked `unusuallyLong`.
- A size-split part keeps its own `pageStart`/`pageEnd` and its own `pageMarkedText`; analysis input uses that stored text and never re-slices pages by a clause range.
- Chunk confidence: after chunking, the page gaps/overlaps, missing/repeated clauses, size/input limits, long clauses, shared page ranges and clause-count plausibility decide whether to keep structured chunks or rebuild structure-free (~1000 tokens, sentence cuts, short overlap). The chosen mode and reason are stored on the document and shown in the Chunk check panel. Chunks that fail size or page-range checks are never sent.
- `checkChunks` (shown as the "Chunk check" panel) reports page gaps/overlaps, above-max chunks, chunks above the model input limit, bad starts, missing/repeated clauses, size-only clause splits, section breaks, clauses over N pages and shared page ranges. A separate analysis-chunk check shows the same for the smaller analysis chunks.
- The pre-flight guard in `runTask` estimates prompt+input tokens and fails locally as `input_too_large` before any model call; the provider's error message is stored as `failureMessage`/`failure_message` and shown in the failed-task table.
- Partial analysis runs are marked `partial`; the report lists failed clauses (number, pages, code, message), adds "N of M clauses not analysed" to the overview, labels missing claims as unverified, and is `unreliable` when more than 10% of clause units fail. "Retry failed only" splits oversized inputs and retries up to five failed units.
- Structure-free coverage is chunk/page based: "N of M chunks analysed, pages covered X of Y", with failed chunks listed by page range. Model-reported clause numbers are not used as a manifest in this mode, and the UI hides clause labels.
- Verified items repeated across overlapping chunks (same page and equal/heavy quote overlap) are deduplicated; the report records items and clauses before/after.
- Failed clause chunks are retried once after the pass with a backoff delay. Over-length section summaries are split into two smaller groups instead of failing.
- Analysis metrics include 429 events and total 429 wait time. `autoReduceConcurrency` lowers concurrency after repeated 429s (default on).
- Supabase sessions refresh before proxy calls and once on a 401; the local edge runtime uses `verifyJWT:true` with ES256 JWKS, so a stale/invalid user JWT appears as `UNAUTHORIZED_ASYMMETRIC_JWT` or `auth_required`.
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

## Deep Analysis page (`/analysis/:docId`)
- Start screen: Matter, Detail level (brief/standard/detailed: clause summary length and overview sentences), Focus (steers the risk checks only), Custom prompt (optional). The pre-run estimate is an upper bound (`costEstimate.ts`) and includes the custom pass when the prompt is filled.
- Start, Resume (interrupted run) and "Retry failed only". The page keeps a per-document run record in localStorage (`legal-app.analysis.<docId>`) until a run finishes with no failed tasks.
- Retry: `runAnalysis({ resumeRunId, retryFailed: true })` resets failed tasks of the planned passes to `queued` and re-runs them with their original input. Finished results are reused and never called again. The report is then rebuilt from stored results. A failed chunk that finished on a later pass is no longer counted as failed.
- A run and removal both hold `doc:<hash>`; removing a document is refused while a run or preparation holds it.
- Clause call (`clause-analysis-v3`) returns risk priority/basis/suggestion/laws, `missing` and `prose`. Risk priority is High only for void/unenforceable, illegal, statutory-violation or major-financial bases (`rubric.ts`). Law references are names only, labelled "model knowledge, applicability unverified".
- Custom prompt pass (`promptPass.ts`) runs per analysis chunk; answers are verified against the cited page; duplicates merged.
- Report model (`reportModel.ts`, pure, shared with the exports): sections numbered in code (Prompt Result only when used); Defined Terms absent. Unnumbered entries are placed by their verified quotes, then by their chunk's clause list (`chunkClauses`), else kept as separate rows and counted. Numbered entries with the same clause number merge: longest non-empty text per field, unioned lists, deduplicated items. Merge stats appear in the Clause Breakdown.
- Prose fields (summary, conditions, rights, etc.) are model-written and cited to clause/page. Quoted text is always verified text. Dates, Amounts and Location mismatch rows appear only when present.
- Citation click opens the stored PDF page in a right-hand panel; the quote is highlighted by `citationLocate.ts` when it can be found on the page.
- Export (`src/export/`): `blocks.ts` turns a `ReportModel` into one ordered block list (title, metadata, static TOC, headings, paragraphs, lists, tables, footer). The DOCX (`docx.ts`) and HTML (`html.ts`) writers render only those blocks, so both match the screen exactly and neither invents content. Exports are built from the in-memory model, so a report restored from Supabase exports identically.
- DOCX: real tables, built-in Heading 1/2/3, static TOC (numbers and titles, no page numbers), footer with "AI-assisted, requires lawyer review" and page numbers, citations as "Clause N · p. X", model-written labels kept, priority as plain text (no shading). Headings keep with the following table.
- HTML: one self-contained file (inline CSS, no external requests), light and dark by preference, print rules, repeated table headers. The TOC is a list without markers because the numbers are in the text.
- Export bar on the report view; file name is the document name plus the date. Large reports show clause progress and yield every 20 clauses while blocks are built.
- `scripts/render-export-check.ts` renders the fixture for a LibreOffice/PDF layout check (bundle with esbuild; not part of the app).
- Reviewing for (Licensor / Licensee / Neutral, default Neutral) is stored with the run. It frames risk priorities, suggestions and the custom answer only; it never limits what is reported.
- Risk prompt lists material one-sided patterns (repairs on one party, penalty formulas, entry without notice, asymmetric notice, forfeiture, unilateral escalation, court waivers), adds statutory costs shifted wholly to one party, and marks asymmetric notice/termination as at least Medium. High-eligible examples: waiver of access to courts, total forfeiture of a large deposit, compounding unilateral escalation. High guard unchanged.
- Missing pass: gets the clause list and the document type; the prompt asks for up to 10 absent typical protections. A hit covers a claim only when its matched text contains the topic's own words: the full phrase, or every non-generic core term compared by six-character stem (`refund` matches `refund mechanics`, `indemnity` matches `indemnify`). Generic words (`law`, `act`, `clause`, `party`, `agreement`, `document`) never cover on their own. Coverage also needs a keyword hit with fused score at least 1/110 (`COVER_MIN_FUSED`). A weak vector-only hit keeps the claim as verified missing. A failed or empty search keeps the claim in a separate "Possibly missing (not verified by search)" list, never used by the summary gap guard. Stats "N proposed, M kept, K dropped by search; pass ran: yes/no; raw items: N; rejected by schema: M" and a dev-visible dropped list (topic and hit page) are stored and shown in the Risk Register. Item shape is tolerant (`topic`/`title`/`protection`, `text`/`description`/`detail`); unusable items are counted as rejected, never reported as zero proposed. A group cut off at the output cap (`failureCode=length`) is retried as two smaller calls, not with a larger cap.
- Overview: 13 points (no Risk Allocation point) as short cited paragraphs, 3-5 sentences scaled by detail level. Points 10 (Statutory Compliance), 11 (Notable Drafting Issues) and 12 (Internal Inconsistencies) are built in code. Points 8 (Termination and Exit) and 9 (Dispute Resolution) are written from focused evidence: hybrid search for the topic, with a keyword fallback over the clauses' page text. Executive Summary (point 13) is one constrained call over points 1-12, the risk lines and the verified Missing list, with a code guard that drops a gap claim when the Missing list is empty; a cited-sentence fallback is labelled "Assembled from cited sentences above."
- Drafting issues (`textQuality.ts`, code only, never model): unfilled blanks (`___`, `[ ]`, `___ days`) and reviewer comments (`Commented [..]`, `[TBC]`, bracketed notes), grouped by clause and page with counts in point 11. Signature material is excluded in any format: Witness/Signed/In the presence of, a capitalised party label followed by underscores, a label with a short name then underscores (`Licensor: Name ____`), and the trailing signature region (unless a schedule/annexure follows). Excluded lines are never attributed to a clause. One Medium risk per clause whose blank touches money, time or a party; comment text is never analysed as a term.
- Internal inconsistencies (`inconsistencyChecks.ts`): a finding needs two verified quotes, a shared subject and a shared party, and a one-line reason. Checks: irrevocable/non-terminable vs termination, arbitration vs exclusive court, two deposits/guarantees for one purpose, two figures in one clause for the same subject and kind, and different termination notice periods (escalation/review intervals never count). Different categories or parties never flag; an empty result is normal.
- Risk Register has an Affects column. `inferAffects` fills it from a party named in the risk text, then its roles, then the clause's obligations, else "Both/unclear" (never "Not identified"). The reviewing side frames suggestions; Neutral shows the affected party. Suggestions must name the concrete change. The rubric also looks for irrevocable grants, tax allocation, assignment/consent restrictions, unilateral rights and one-sided indemnities; neutral obligations with no exposure are not risks.
- Law names dedupe by `lawKey` (year and punctuation ignored), so "…Act" and "…Act 1999" count once.
- Law references name the Act that fits the issue; the clause prompt says not to default to the Indian Contract Act. Statutory Compliance (`statutory.ts`) keeps at most six Acts: those engaged by a risk or missing item, plus the Acts central to the document type from a small subject map (lease/occupancy, agreement, deed/sale, notice; unknown types get none). A model-proposed Act is kept only when it is central; unrelated Acts are omitted. Dedupe by `lawKey`.
- Executive Summary (`summaryGuard.ts`): summary sentences are validated by citation only (they carry no point number). Absence claims are dropped unless the verified Missing list has an entry; escalation-type matches are ignored. The fallback is short: nature, parties and key terms, at most six cited sentences, labelled "Assembled from cited sentences above." The synthesis and summary prompts state that the entire reply is one JSON array with object elements (never bare strings) and include an example; this keeps `bad_json` from prose replies down.
- Overview points 8 and 9 state the actual terms (who may terminate and on what notice; who decides a dispute, forum, waiver), not only that a process exists.
- Risk Register: clause rubric excludes generic disclaimers, forward-looking warnings, "no assurance" boilerplate, selling/jurisdiction restrictions, definitions and neutral procedures, judged by effect on a party (liability/right/remedy limits stay risks). A batched validation pass (`riskReview.ts`, 20 per call, High and Medium only) keeps, downgrades or drops each risk and removes duplicates (same clause and issue); the report shows "N risks after validation (M dropped)". Fail open if a batch fails. Never-drop guard (`riskGuard.ts`): a term that puts a cost or liability on a named party (cost keyword plus bear/borne/pay/liable/indemnify/forfeit, with a party name or a generic role) can be downgraded but not dropped; boilerplate mentioning fees stays droppable. Drops and reasons are stored and shown in a dev-visible list.
- Dates and Amounts are two tables (Dates: date/what it is/fixed or relative/clause/source; Amounts: amount/what it is for/payer to payee/when due/clause/source). A missing purpose falls back to the verified quote.
- Prompt Result: when a custom prompt is set at run start, it rides in the clause call as a short `promptAnswer` field (up to 5 verbatim quotes per clause, or []); there is no separate per-chunk pass. Verified quotes go to one synthesis call (`prompt-synthesis-v2`) that writes the answer in prose, citing them; supporting quotes are grouped by clause. No per-chunk answer lines. A split or retried clause call still contributes its `promptAnswer`; retry-failed re-queues the synthesis. If the write-up call fails, the report says the answer could not be generated and still shows the verified quotes; it does not claim nothing was found.
- Post-report prompt (`promptOnReport.ts`): retrieval mode reads the most relevant chunks (`VITE_PROMPT_RETRIEVAL_CHUNKS`, default 12) selected by hybrid search, then synthesises; whole-document mode reads every chunk. The result records its mode and shows "Based on the N most relevant sections of C", with a "Scan whole document" action. The report page shows a call/cost estimate per mode. The general analysis is not recomputed.
- Clause Breakdown is collapsed by default on screen (exports unchanged).
- No Timeline section. Section numbering follows the model (7 sections without Prompt Result, 8 with it).
- Clause table rows: Summary always; others only when they have content. No Missing row (the missing protections are in the Risk Register). Clauses sort by clause number, numerically; underscores in labels are shown as spaces.
- Coverage: no clause count in structure-free runs or when zero; chunk and page coverage only.
- Retry-failed refreshes the stored prompt, prompt version and fingerprint from the current plan before re-queuing a failed task, so a retry after a prompt fix uses the new prompt. The synthesis task is re-queued with the current template too.
- The failed-task table shows the first 300 characters of the stored raw response for each failed attempt, so `bad_json` and similar failures can be diagnosed without the browser devtools.
- Tests use the hosted Supabase project (`testSupport.ts` helpers); `runAnalysis.retry.test.ts` covers retry.

## Commands
- `npm run dev` the SPA (local `.env.local`; runs `scripts/copy-pdfjs-assets.mjs` first)
- `npm run dev:hosted` the SPA against the hosted project (`.env.hosted`; runs the asset copy first)
- `npm run build` type-check + local build (asset copy first)
- `npm run build:hosted` type-check + hosted build (`--mode hosted`; asset copy first)
- `node scripts/copy-pdfjs-assets.mjs` copies pdf.js wasm/cmaps/standard fonts into `public/`
- `npx esbuild scripts/render-export-check.ts --bundle --platform=node --format=esm --define:import.meta.env='{}' --outfile=$HOME/render.mjs && node $HOME/render.mjs out.docx|out.html` renders the export fixture for a layout check
- `npm test` unit tests (runTask with fake-indexeddb, chunker, page quality, OCR output check, library status)
- `python3 tests/fixtures/make_fixtures.py` regenerates test PDFs (scanned30.pdf is gitignored)
- `python3 scripts/plant_facts.py --out tests/fixtures/planted.pdf --golden tests/golden/planted.json` regenerates the planted-fact PDF and golden file (synthetic text only; add `--seed`, `--pages`, `--facts`)
- `npx supabase start`, then `npx supabase functions serve ai-proxy --env-file supabase/functions/.env`
- Hosted setup: `npx supabase link --project-ref <ref>`, `npx supabase db push`, `npx supabase secrets set --env-file supabase/functions/.env`, `npx supabase functions deploy ai-proxy`. See `docs/hosted-supabase.md`.
