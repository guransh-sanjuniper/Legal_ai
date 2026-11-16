# Legal Document AI App: Project Handover (end of harness phase)

Read this first. It supersedes `pipeline-harness-context.md` and amends `legal-app-pipeline-context.md` (v2) wherever they conflict. Date: 11 Nov 2026. Owner: Guransh.

---

## 1. Project in one paragraph
A **web app (SPA)** for a real estate firm's legal team (Maharashtra, India) that processes very large documents and contracts (500-1000 pages) with AI. Four modules: **Deep Analysis, Comparator, Drafter, Main Chat**. Everything must be grounded in Indian/Maharashtra real estate law (RERA, MahaRERA rules, MOFA, Maharashtra Stamp Act, Registration Act, etc.), checked against a list of laws supplied by the firm. Goal: large documents work **without failing**, every finding is citable (page + verified quote), and reports state honestly how much was actually covered. Outputs always carry "AI-assisted, requires lawyer review".

## 2. Where we are
A throwaway **test harness** was built to prove the pipeline before building the app. It is built, committed, and has run at scale. Verdict: **conditional go**. Build the main app on this core, module by module.

Not yet proven (do alongside Module 1): (a) **interruption tests** (close tab mid-analysis, sleep laptop; both must resume with no duplicates), (b) 2-3 more real contracts including one scan/Marathi document and one hold-out, (c) lawyer-readable answer format (prose answers, see section 9).

**Timeline:** the user plans to build the main app in about 3 days, starting tomorrow, using opencode. A thin version of all four modules is feasible; lawyer-trusted quality is not (no lawyer review planned yet).

## 3. Fixed decisions (do not revisit without a reason)
- Web app only (Electron/Tauri rejected). React + Vite SPA.
- **Data in the browser (IndexedDB):** PDF blob, extracted pages, chunks, embeddings, task/batch state, OCR corrections. **Results in Supabase:** per-task results, reports, run records. The original document is **not** uploaded to Supabase.
- **Browser coordinates AI batches** via a runner in a worker, outside UI components, with a Web Lock per document. **No pg_cron, no server task queue, no hosted worker.**
- AI calls go through a **stateless Edge Function proxy** (`ai-proxy`) holding the OpenRouter key. The key never reaches the browser.
- **Verification is code, not model:** every quote must exist on the cited page in stored text; the model only proposes. Page and clause labels come from where the quote is found.
- **Honest coverage:** a ledger (processed / analysed / verified); reports marked `partial` or `unreliable` when needed; a failed unit never stops the document.
- `runTask(db, task, cfg)` is plain TypeScript (no browser-UI or Edge APIs), so it can move to a Node worker later if unattended runs are needed.
- Embeddings run locally in the browser: `multilingual-e5-small` (q8), pinned version, 400-token windows pointing to parent chunks. Keyword index: MiniSearch with a Unicode tokenizer (`\p{L}\p{M}\p{N}`) so Marathi/Hindi words stay intact. Hybrid search by reciprocal rank fusion.
- Nothing document-specific in code or prompts (generality rule). Add a rule only when 2+ documents show the same failure. Hold-out documents are never used for tuning.
- Supabase: local (CLI + Docker) for development; **Supabase Pro** for production (backups, no pausing).
- Output carries "AI-assisted, requires lawyer review"; law-based risks are marked "applicability unverified".

## 4. Environment (local dev)
- Repo: `~/Development/Legal App/Pipeline_Harness` (git; latest commits listed in section 6).
- Dev model in opencode: Haiku 5.5 (low effort). One new opencode session per prompt. `AGENTS.md` is read at session start.
- **Local Supabase ports (own range, because another project uses defaults):** api 55321, db 55322, shadow 55320, pooler 55329, studio 55323, analytics disabled (55327), `[local_smtp]` disabled (55324), edge inspector 8183. Start: `npx supabase start`; proxy: `npx supabase functions serve ai-proxy --env-file supabase/functions/.env`; app: `npm run dev` (port 5173).
- Env vars (`.env.local`, gitignored): `VITE_SUPABASE_URL=http://127.0.0.1:55321`, `VITE_SUPABASE_ANON_KEY`, `VITE_MODEL`, `VITE_SEARCH_MODEL` (definitions; `openai/gpt-4o-mini`), `VITE_ANALYSIS_MODEL` (`openai/gpt-4o-mini`, reasoning minimal), `VITE_FALLBACK_MODEL` (`mistralai/mistral-small-24b-instruct-2501`), `VITE_CONCURRENCY` (default 3), test user credentials. Secrets in `supabase/functions/.env`: `OPENROUTER_API_KEY`.
- Test user: `test@harness.local` (local Auth). RLS is off in the harness (throwaway project).
- Pages in the harness: `/?page=ingest`, `search`, `analysis`, `quality` (default route is the P1 test page).
- Note: DeepSeek V4.1 Flash burns its output budget on hidden reasoning and returned empty content, so it is not the current analysis model. A bake-off is still open (section 10).

## 5. Architecture as built

### Folders
`src/ingest` (extraction, quality, OCR, chunking, checks), `src/retrieval` (embeddings, keyword index, hybrid search, definitions, law stand-in), `src/runner` (IndexedDB layer, worker, client, `runTask`), `src/tasks` (types, validation, fingerprints), `src/analysis` (prompts, verification, roll-up, ledger, judgement, amounts, anchors, scoring, UI-facing logic), `src/quality` (scorer, history, repeat-run, regression), `src/ui` (pages), `supabase/migrations`, `supabase/functions/ai-proxy`, `tests/golden`, `tests/fixtures`, `scripts/plant_facts.py`.

### Pipeline
1. **Ingest (browser, tab open):** pdf.js in a Web Worker, page by page with physical page numbers, saved incrementally (resume skips saved pages). Page quality check (text length, garbled ratio, image coverage). Tesseract.js OCR (eng/mar/hin per document, 200 DPI, 300 DPI retry), nonsense and wrong-language rejection, page review UI (accept/correct/blank/leave/retry), corrections preserved on recheck. Ready only when every page is final and chunks saved. SHA-256 document hash + preparation fingerprint (includes chunk config and OCR corrections). `navigator.storage.persist()`.
2. **Chunking:** clause-aware (sequence rule: `N)`, `N.`, `1.1`, `(N)`, `Section N`, `Clause N`, `Article`, lettered sub-items incl. multi-letter `aa..hh`; tables never boundaries; lettered recitals with one restart). Sizes are config (ingestion 1250 target / 2500 max / 300 min tokens; analysis chunks about 700 target / 1200 max). **Confidence check with automatic fallback to structure-free chunking** (paragraph/sentence cuts, about 1,000 tokens, short overlap) when clause structure is unreliable. Each chunk's page span comes from its own text. A pre-flight guard blocks any input over the model limit (`input_too_large`). A Chunk check panel reports gaps, overlaps, over-long clauses, section breaks, oversized chunks, mode and reason.
3. **Search:** embeddings and keyword index built after ingestion; hybrid search returns chunk, page range, clause, scores, and the matching window. A law stand-in (about 20 PLACEHOLDER passages, marked TEST DATA) is searched the same way. Definitions sheet (parties with role `party_to_agreement`/`mentioned`, defined terms, key dates) built by small tasks and attached to later tasks.
4. **Runner:** tasks in IndexedDB; Web Lock per document; concurrency from config (3) with one shared backoff gate and auto-reduce after repeated 429s; max 3 retries with fallback model; never retries 400/401/403; `finish_reason=length` splits the unit (min size and max depth); raw response saved locally **before** parsing; per-item JSON validation; attempt IDs fence stale results; Supabase saves use idempotency key (task_id + fingerprint); lost requests marked `uncertain` and retried; the Supabase run record is authoritative for status; session refreshed before each proxy call.
5. **Analysis (map):** one task per analysis chunk (page markers `[[pN]]`, definitions sheet attached) returning per-clause JSON (type, obligations, dates with timing type, payments, risks); one result per clause required, skipped clauses retried once; sub-item pass for lettered sub-items; deterministic amount/percentage/duration extractor (Indian formats) shown as "code-extracted (unclassified)" and used for an "uncaptured amounts" list; law lookup for risks; code-side quote resolution (cited page, then chunk range, then whole document).
6. **Reduce:** dedupe across overlapping chunks; section summaries from verified items in groups of 30-60; overview (every sentence cites item ids, uncited dropped); cross-clause pass in code (payment totals, contradictions, missing-topic candidates checked by whole-document search first); coverage ledger; report saved to Supabase and restorable after reload; "retry failed only" and a repair pass.
7. **Judgement / whole-document / custom prompt:** same question per chunk, items `{clause, quote, direction (favours_a/favours_b/neutral, party-neutral), why, confidence}`, verified, merged by clause. Ask box has retrieval mode and whole-document mode (user chooses; no auto-router yet).
8. **Quality suite:** generic scorer reading `tests/golden/<doc>.json` (`{doc, holdout, note, expected:[{clause, token, kind, contains?, reason?}], removed:[...]}`), planted-fact generator, repeat-run comparison, regression set, report page.

### Supabase schema
`runs`, `task_results` (unique `task_id + fingerprint`; includes `failure_code`, `failure_message`, tokens, provider, duration, attempt), `reports`, `rate_limits`; SQL functions `save_task_result` (idempotent) and `increment_rate_limit` (atomic). Migrations: `0001_foundation.sql`, `0002_failure_message.sql`.
IndexedDB (version 3): documents (with PDF blob), pages, chunks, embeddings, embedding_windows, embedding_state, tasks, raw_responses, run_state, ocr_decisions, definitions, analysis_reports, analysis_state.

## 6. Commit history (most relevant)
`b2065b6` P1 foundation (runner, proxy, runTask) · `ce21c6b` P2 ingestion · `7dbcdc0` chunk config · `a493118` clause detection fixed on real contract · `9de80e2` P3 search · `00c6ef5` P4 analysis/Ask/metrics · `a430db3` P4b/c recall and judgement · `5f132a2` P4d concurrency, generality · `4e6260a` golden file correction · `7d84a3e` P5 quality suite · `7cd75a3` provider error messages · (oversized-input fix and structure-free fallback; hash not recorded here) · `0f99c3c` structure-free coverage, dedupe, repair. Tests: about 195 passing; type-check and build clean at last report.

## 7. Results so far

| Run | Result |
|---|---|
| P1 six checks (live) | All PASS: end-to-end, 401 fail-fast, split on length, timeout, kill-and-resume with no duplicate row, second-tab lock |
| 65-page contract (Hiramoti, local test file) | 59 clauses detected in order; 110 clauses analysed, 0 skipped; model-only payment recall about 62-67%, **100% with code extractor**; favour recall 11/13 (84.6%) on the corrected golden list (13/16 = 81.3% on the old list); 0 invalid quotes shown; about $0.10 for analysis + judgement; embedding 37 s |
| 59-page development agreement (Landowner/Developer) | 60 chunks analysed, 75 calls, about $0.07; judgement returned 436 clause rows (too noisy; see section 9) |
| **493-page prospectus** | structure-free mode (structured mode rejected by the confidence check); 764 calls; $0.3163; 27 min; 190 429-events absorbed; 6 failed tasks (0.85%); after repair 664/664 chunks and 493/493 pages, `partial:false`; 1,771 verified items after dedupe |

## 8. Bugs found and fixed (so they are not repeated)
- Embedding client resolved on progress messages (law search returned undefined).
- Ingest stall after a tab was killed (lock/heartbeat; resume now visible and self-recovering).
- **Oversized input (HTTP 400, 325k tokens):** size-split parts inherited the whole clause's page range and the input builder re-sliced pages. Fixed by building input from each chunk's own text, clause closing and restart handling, and a pre-flight guard.
- 233 `UNAUTHORIZED_ASYMMETRIC_JWT`: stale session; now refreshed per call.
- DeepSeek empty output from reasoning; `empty_output` guard added.
- Provider errors were hidden; now stored and shown (`failure_message`).
- Golden file had entries that violated the burden rule (obligation is not a favour); corrected, with reasons recorded.
- Multi-letter sub-item labels (`hh)`) not parsed; fixed.

## 9. Known weaknesses (carry into the main app)
1. **Answer format:** whole-document answers are an item table (436 rows). Final app needs a prose answer written from verified items, with a collapsed Evidence section and an "all items" toggle. Length must follow data/config, not fixed numbers.
2. **Payments:** model-only recall about 62-67%; payer/payee sometimes wrong (the direction is guessed); non-payment amounts listed as payments. Fix: require a payment verb in the quote; payer/payee must be stated or "not stated"; move other amounts to "amounts mentioned".
3. **Overview:** can misstate a source (changed comparatives/direction), leans on early pages on very large documents, uses internal IDs as citations. Fix: key-figure/direction check per sentence, per-section quota, page-number citations.
4. **Severity:** boilerplate/disclaimers rated high. Needs a rubric ("info" vs "high" requires a concrete adverse consequence for a named party).
5. **Judgement precision:** direction labelling is noisy, and duties benefiting the counterparty are sometimes called neutral.
6. **Whole-document questions are slow** (about 60 calls for 65 pages, about 700 for 500). Plan: router (saved results / retrieval / filtered pass / whole-document), filtered pass (hybrid search first, judgement only on top chunks, count from config or score cutoff), cost and time preview, caching, tags in saved clause JSON.
7. **Generality is unproven:** chunker and prompts were developed on essentially one contract style. Test on more documents; keep hold-outs.
8. **Document types:** classification exists (`agreement|lease|deed|notice|other`) but only picks prompt hints; a prospectus through the contract checklist gave weak output.
9. **Law library is placeholder.** Risk checks are not real until the firm's list is loaded.
10. **Runtime:** browser must stay open for the whole run (about 27-30 min for 500 pages). No overnight runs. IndexedDB can be cleared/evicted; documents are device-bound (reports are not). Local data is unencrypted.
11. Marathi/Hindi analysis and scanned documents not yet run end to end (only OCR/search tests on fixtures).
12. Hard parts of 429s: concurrency 3 is at the limit for this provider.

## 10. Open decisions
- Firm's law list: format, source, update process; where it is indexed (Supabase pgvector for this shared non-confidential data, or a versioned pack in IndexedDB).
- Embedding provider switch (`local` vs `openrouter:<model>`) behind one interface; test on Marathi/Hindi.
- Model bake-off on the same document (DeepSeek with reasoning off vs gpt-4o-mini vs others); possibly a stronger model only for overview/cross-clause/high-severity steps; per-model limits and prices in config.
- IndexedDB encryption at rest; a "remove document from this device" action.
- Whether to add DOCX input (Mammoth) and DOCX export.
- Server runner for unattended runs (only if users demand it).
- Spend cap and cost preview; set a spend limit on the OpenRouter key.

## 11. Plan for the main app

### Reuse, don't rewrite
Import the harness core (`ingest`, `retrieval`, `runner`, `tasks`, `analysis`, `quality`) into one codebase with routes per module. Harness pages are throwaway; modules get new UI.

### Build order (3-day target, thin versions first)
- **Day 1:** app shell (routes, auth, document library), **Deep Analysis** UI (prose answer, evidence, export), run the **interruption tests**, start the **Chat router** (saved results, retrieval, preview).
- **Day 2:** Chat filtered pass; **Comparator** (thin: two documents, one mode; align by local retrieval, LLM check on aligned pairs, one task per pair, "no match" list, citations from both sides); load the real **law library**; payments/overview fixes.
- **Day 3:** **Drafter** (thin: facts sheet confirmed by user, outline approved by user, one task per section sequentially with shared drafting memory, consistency pass, placeholders for unknown values, DOCX export); auth, RLS, audit log, hosted Supabase Pro, deploy.
- **If time runs short, cut:** Drafter first, then Comparator extra modes, then DOCX export. Keep Deep Analysis and Chat.

### Module specifics (from the design)
- **Deep Analysis:** per-clause results, section summaries, full overview (length scales with document), dates/obligations/payments/risks, law lookup with "applicability unverified", coverage ledger, partial/unreliable states.
- **Comparator:** modes: specific clauses, similarities across whole documents, against a reference document. Needs both documents present in the same browser. Quote and page from both sides; timing classification (fixed / event-relative / none).
- **Drafter:** unknown values become placeholders; check that any number or party name exists in the facts sheet or sources; cross-reference and defined-term consistency pass; sequential sections, so long drafts are slow and must stay open in the browser.
- **Chat:** router; verified citations; "not found" instead of guessing; cost/time preview before whole-document passes.

## 12. Working conventions with the user
- **Keep chat replies short** (user preference: minimize chat tokens). Prompts for opencode can be detailed.
- **One clear goal per prompt**, with a "Done when" check the user can run, and "plan first, then wait for approval" for risky prompts (runner, idempotency, auth).
- Explain each code change; no blind fixes. Commit after each passing prompt; new opencode session per prompt; keep `AGENTS.md` current.
- The user wants **working, not perfect**. Don't chase scores on one document; fix general failures only.
- The user pastes opencode's reports back; check them against the PDFs and the rules in section 3, and point out overfitting or unverified claims.
- Use real-provider tests, not mocks. Use the production model for quality tests.

## 13. How to start the new chat
Send the files in section 14, then this message:
"This is the handover for my legal document AI app. Read `legal-app-handover.md` first, then the two context files. Tomorrow I start building the main app with opencode (Haiku 5.5). Give me Prompt 1 for the app shell and Deep Analysis UI, with a plan-first instruction, a Done-when check, and the reuse rules from section 11. Keep chat replies short."

## 14. Files to share (and not share)
**Always share (from this chat's outputs):** `legal-app-handover.md`, `legal-app-pipeline-context.md` (v2), `pipeline-harness-context.md` (history; handover wins on conflicts).

**From the repo (helps the new chat see real names and schemas):**
- `AGENTS.md`
- `package.json`
- `supabase/config.toml` (ports)
- `supabase/migrations/0001_foundation.sql`, `0002_failure_message.sql`
- `supabase/functions/ai-proxy/index.ts`
- `src/runner/db.ts`, `src/runner/runTask.ts`, `src/tasks/types.ts`
- `src/analysis/types.ts`, `src/analysis/config.ts`, `src/analysis/prompts.ts`
- `src/ingest/chunk.ts` (config and rules), `src/retrieval/config.ts`
- `tests/golden/hiramoti.json` (format example; contains no document text)
- A file list and git log (commands below)

**Optional:** `brookfield-report.html` and `Result_large_doc.html` (examples of current output quality), and 1-2 small test PDFs if the new chat should reason about real documents (do not share confidential client documents).

**Never share:** `.env`, `.env.local`, `supabase/functions/.env`, any API key, service-role key, `node_modules`, browser data.

Generate the extras:
```
cd "$HOME/Development/Legal App/Pipeline_Harness"
mkdir -p handover
find src supabase tests scripts -type f -not -path "*/node_modules/*" | sort > handover/file-list.txt
git log --oneline > handover/git-log.txt
cp AGENTS.md package.json supabase/config.toml handover/
cp supabase/migrations/*.sql supabase/functions/ai-proxy/index.ts handover/
cp src/runner/db.ts src/runner/runTask.ts src/tasks/types.ts handover/
cp src/analysis/types.ts src/analysis/config.ts src/analysis/prompts.ts handover/
cp src/ingest/chunk.ts src/retrieval/config.ts tests/golden/hiramoti.json handover/
```
If two files share a name (for example `index.ts` or `types.ts`), rename them when copying (for example `proxy-index.ts`, `tasks-types.ts`, `analysis-types.ts`) so none is overwritten, then upload the contents of `handover/`.
