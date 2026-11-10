# Legal Document AI App: Pipeline and Project Context (v2: browser-local processing)

Give this file to a new chat as full context. It covers the aim, the reasons behind each decision, the proposed pipeline, and the open points. The test harness is specified separately and must follow this version.

**v2 change:** documents, extracted text, chunks and embeddings now live in the browser (IndexedDB). The browser coordinates AI batches. There is no Supabase task queue and no `pg_cron`. AI calls still go through a backend proxy. Results and final reports live in Supabase. The modules and their intended functionality are unchanged.

---

## 1. Aim

Build a **web app** for a real estate firm's legal team (India, Maharashtra) that processes very large documents and contracts (**500-1000 pages**) with AI and returns accurate, citable results. It should be reusable for other legal firms with minimal changes.

All outputs are based on **Indian and Maharashtra real estate law** (RERA, MahaRERA rules, MOFA, Maharashtra Stamp Act, Registration Act and similar). The firm supplies a **list of required laws**. The AI must check against that list and must not ignore relevant laws outside it. Other legal questions are also allowed.

## 2. Main goal

**Large documents must work without failing**, and results must be trustworthy enough for lawyers to rely on after review.

1. A 1000-page file is prepared and analysed without timeouts, lost work, or silent gaps.
2. Every finding cites a page and clause, and every quote is checked against the stored text.
3. Reports state honestly how much was processed, analysed, and verified.
4. Interrupted runs (closed tab, sleep, crash, provider error) resume without redoing finished work.

## 3. Modules (each separate; unchanged)

1. **Deep Analysis:** detailed explanation of how each clause or section works. A proper overview whose length scales with the document. Dates, obligations, payments. Risks and suggestions based on Maharashtra real estate law, checked against the firm's law list.
2. **Comparator:** compare multiple documents and their clauses as the user requests: specific clauses, similarities across whole documents, or documents against one reference document. Works on the full large documents.
3. **Drafter:** draft large legal documents and contracts (up to about 500 pages, or small ones) from provided documents, prompts, or information.
4. **Main Chat:** general legal questions, questions about uploaded documents, and questions about module results. High accuracy, with citations.

## 4. Why this architecture

| Problem | Decision |
|---|---|
| A 1000-page document (about 500k-750k tokens) cannot go to the AI in one call | Parse once, store locally, and process in small batches |
| Request limits on backend functions | No long work inside a request. Each AI call is a small, separate request through a proxy |
| The API key must never reach the browser | All OpenRouter calls go through a backend proxy (Edge Function) |
| No hosted worker, no server task queue wanted | The browser coordinates processing |
| Confidential documents | Full documents, text and embeddings stay on the user's device. Only chunks sent for analysis leave it |
| Retrieval alone can miss clauses | Two tracks: full analysis reads every clause, retrieval is used for search |
| AI claims "missing clause" when it exists elsewhere | Definitions sheet on every task, and a whole-document search before flagging "missing" |
| Reports say "done" when work was partial | A coverage ledger with separate processed, analysed, and verified counts |

## 5. Constraints and decisions already made

- **Web app (SPA).** Desktop apps (Electron, Tauri) were rejected as too much hassle.
- **Where data lives:**
  - **Browser IndexedDB:** the original PDF (and DOCX if added), extracted pages, chunks, embeddings, preparation status, OCR corrections, and the local task/batch state.
  - **Supabase:** completed batch results, final reports, run records, and the audit log. Reports are accessible after reload or on another device.
  - The original document is **not** uploaded to Supabase.
- **Processing:** the browser coordinates AI batches. Closing the browser pauses new processing, and reopening continues it. There is **no `pg_cron` and no server-side task queue**.
- **AI calls** go through a stateless backend proxy (Supabase Edge Function) that adds the OpenRouter key and calls the provider. The user's login token authorises each call, with per-user rate limits.
- **Source previews** (cited page next to a finding) run locally from the stored PDF.
- **Retrieval runs locally** over the IndexedDB chunks and embeddings. There is no pgvector or Postgres full-text search for documents.
- **Supabase:** local Supabase (CLI + Docker) for development. Supabase Pro for production (backups, no pausing of the results store).
- **OpenRouter** is the AI provider. Prefer providers with zero data retention for client documents.
- **No hosted worker** and nothing paid beyond Supabase Pro and OpenRouter usage.
- **Escape hatch:** `runTask` is plain TypeScript with no browser-UI or Edge-specific APIs. It runs in a browser worker now. The task record has the same shape that a database queue would use, so a server runner could be added later (for unattended runs) without redesign.
- **Verified Edge Function limits (Supabase docs), which apply to the proxy:** wall clock 150s Free / 400s paid, CPU 2s per request (async I/O such as waiting on OpenRouter does not count), memory 256MB, request idle timeout 150s (504 if no response).
- **Embeddings** run in the browser (transformers.js) with a **multilingual** model (for example multilingual-e5-small) because of Marathi/Hindi. Pin the model and version. Queries must use the same model. Keep a fallback to an OpenRouter embedding model through the proxy.
- **Keyword search** is a local index (for example MiniSearch or FlexSearch). It needs a tokenizer that handles Marathi/Hindi.
- **DOCX input** (Mammoth) is a likely addition. DOCX has no page numbers, so citations would use section headings.

## 6. Pipeline

```
Browser (tab must stay open; stores in IndexedDB)         Backend (stateless)      Supabase (results)
─────────────────────────────────────────────────         ───────────────────      ──────────────────
1 Select PDF -> stored as Blob in IndexedDB
2 Extract: pdf.js in a Web Worker, page by page,
  physical page numbers, saved incrementally
3 Quality check per page + OCR + manual review
  (Ready only when every page is accepted/waived)
4 Chunk by clause/section
5 Embed chunks (multilingual model) -> IndexedDB
  + local keyword index
6 Definitions sheet task
        |
        v
7 Create run + task list (IndexedDB)
8 Browser runner (Web Worker, outside the UI)
  one task at a time (small concurrency)  ---------->  AI proxy (Edge Function)
                                                        adds key, calls OpenRouter
  <---------------------------------------------------  returns response
  save raw response locally FIRST
  parse, validate, verify quotes locally
  save result  ----------------------------------------------------------------->  batch results
        |
        +--------------------+-----------------------+
        v                                            v
  Track 1: Analysis                           Track 2: Retrieval (local)
  every clause -> JSON                        hybrid search over IndexedDB
  -> section summaries -> overview            (vector + keyword)
  -> cross-clause pass                        used by chat, comparator, drafter
        |                                     law lookup uses the law library
        +--------------------+-----------------------+
                             v
              9 Verify + coverage ledger
              10 Final report -> Supabase -> any device
```

### Stage 1: Ingestion (browser)
- **Extraction:** pdf.js in Web Workers, page by page, keeping the physical page number. Save pages incrementally so interrupted work is reused.
- **Page quality:** text-quality and image checks, not text length alone. Detect scanned pages, thin text layers, garbled text, and wrong language.
- **OCR:** Tesseract.js (English, Marathi, Hindi) with a per-document language choice. Low-confidence or nonsense output goes to **manual review**: compare image and text, correct, confirm blank, or leave unresolved. Accepted corrections are stored and preserved across rechecks. Confidence alone is not sufficient.
- **Ready state:** Ready only when every required page is accepted or explicitly waived and the chunks are saved.
- **Concurrency:** Web Locks allow one tab per document. BroadcastChannel updates other tabs. Heavy work stays in Web Workers, so the tab can be in the background but must stay open and the device awake (Wake Lock API).
- **Chunking:** split by clause or section boundaries, not fixed pages. Store page range, clause number, heading, and parent section. Target about 3-8k tokens per analysis piece, with overlap or the last clause carried forward. Handle Indian contract numbering variants.
- **Fingerprints:** store a document hash and a preparation fingerprint. OCR corrections change the fingerprint even when the PDF is unchanged. Saved results are matched to the exact source version.
- **Definitions sheet:** one task extracts parties, defined terms, and key dates, and attaches them to every later task.
- **Storage care:** request persistent storage (`navigator.storage.persist()`), watch quota, and warn the user before a large document would exceed it.

### Stage 2: Task runner (browser)
- The runner lives **outside any UI component** (a worker or a plain module), so closing a dialog or changing screens never stops it.
- Task and batch state is in IndexedDB. A Web Lock allows one runner per document. The Supabase run record is authoritative for run status (complete, cancelled), so a late cancel cannot overwrite a completed run.
- **Task rules:**
  - One task is one clause or section, with the definitions sheet attached.
  - Budget **output** tokens as well as input (`max_tokens`).
  - Own HTTP timeout of about 100s on the proxy call. Stream long outputs.
  - `finish_reason=length` splits the piece in two and retries. Never accept truncated JSON.
  - **Save the raw response locally first**, then parse and validate. A browser crash after the response arrives does not lose the paid call.
  - Validate each JSON item separately. Keep valid items and retry only the invalid ones.
  - Each attempt has an attempt ID. Results from superseded attempts are ignored.
  - Saving to Supabase uses an idempotency key (task ID plus fingerprint), so retries and duplicate requests cannot create duplicate results.
  - Max 3 retries with backoff and a fallback model list, then `failed`, with a retry button.
  - A stuck task (request sent, no result recorded) is marked **uncertain** and is safely retried at the cost of one repeat call.
  - Store failure code, finish reason, provider, token counts, duration, and attempt number on every task, locally and in the saved result.
  - Tasks are idempotent. A finished result is reused, never recomputed (also after reload or on resume).
- Roll-up and final stages are normal dependent tasks, each resumable.
- **Interruption:** closing the browser, sleep, or suspension pauses processing. On return the app reconciles local state with saved results, then continues. Unattended or overnight runs are not possible in this version.

### Stage 3: Two tracks over the same chunks
**Track 1, Analysis (reads everything)**
1. Per-clause structured JSON: clause type, parties, obligations, dates (with timing type: fixed date, event-relative such as "before registration", or none), payments, risks.
2. Roll up into section summaries, then the full overview (map-reduce, multi-level if needed).
3. Cross-clause pass on the structured data: contradictions, gaps, payment totals.
4. Risk pass: clause text -> search the firm's law library -> attach law passages -> risk and suggestion with citations. Marked **"applicability unverified"**.

**Track 2, Retrieval (local)**
- Hybrid search (vector similarity computed in the browser plus a local keyword index, optional reranker) over the chunks in IndexedDB. Used by Chat, Comparator alignment, Drafter, and law lookup.
- The firm's law list is a separate, versioned knowledge base. Where it is indexed (Supabase pgvector for this shared, non-confidential data, or a versioned pack downloaded to IndexedDB) is an open decision.

### Stage 4: Verification and coverage
- Every cited quote must exist on the cited page in the stored text (checked locally). Quotes that do not are rejected. The model proposes, and code verifies.
- High-severity findings get a second verification pass. Low confidence is flagged for lawyer review.
- **Coverage ledger:** each clause is tracked as processed, analysed, or verified. Reports show real counts ("320 of 340 clauses analysed"). Cited pages must be marked as checked. The ledger is saved with the report.
- Findings are keyed by clause ID, which removes cross-batch duplicates. If a cap or saturation limit applies, disclose it.
- Severity needs a rubric. Routine blanks and simple completion items are a separate "completion task" category, not High risk.
- Classify each document and section first (agreement, prospectus, accounting section and so on), then choose the right checklist.
- Rewrites must use placeholders. A check confirms that any number or term in a suggestion exists in the source.
- Treat all document text as untrusted data (prompt injection).

## 7. How each module uses the pipeline

| Module | Track 1 | Track 2 |
|---|---|---|
| Deep Analysis | Main engine, over every clause | Law lookup, and a whole-document search before flagging "missing" |
| Comparator | Reuses stored clause JSON | Aligns matching clauses by local retrieval, then an LLM check on aligned pairs, one task per pair, with a "no match" list for both documents. **All compared documents must be present in the same browser.** Modes: specific clauses, similarities, against a reference |
| Drafter | Reuses stored definitions and parties | Finds similar clauses and law text. Outline first, then one task per section with shared drafting memory (parties, terms, numbering, cross-references). A final consistency pass |
| Chat | Reads saved results for aggregate questions ("list all payments") | Specific questions use local retrieval, then one proxy call, and cite page and clause. Says "not found" instead of guessing. Whole-document asks run the question over every clause, then merge. Answers stream through the proxy |

## 8. What works on another device
- **Works:** viewing reports, findings, coverage ledgers, and results saved in Supabase.
- **Needs the document on that device:** source previews, retrieval, document chat, comparing documents, new analysis runs, and re-checking citations. The user imports the PDF again, and saved results are reused if the document hash and preparation fingerprint match. Embeddings and chunks are rebuilt locally.
- **If browser storage is cleared:** results in Supabase survive. The source, chunks, and embeddings must be prepared again.

## 9. Safety and privacy
- RLS on every Supabase table, scoped per user or firm, plus an audit log and role-based access. The proxy requires the user's login and applies per-user rate limits.
- Full documents stay on the device. Chunks sent for analysis leave it, through the proxy. Supabase stores findings, extracted facts, and short citation excerpts.
- IndexedDB data is not encrypted by the app. Device security matters, especially on shared PCs. Provide a "remove document from this device" action, and consider encryption at rest.
- Data residency in India where possible, aligned with the DPDP Act 2023.
- OpenRouter restricted to providers with zero data retention. Check before using real contracts.
- Output carries an "AI-assisted, requires lawyer review" notice.

## 10. Lessons from a previous attempt (what to avoid)
The previous attempt used a similar browser-driven architecture. Its issues, and how this design must respond:
- Large PDFs exceeded backend limits. Browser extraction fixed this.
- OCR needs quality checks beyond text length, per-document language, and preserved manual corrections.
- AI responses hit the output-token limit and returned unfinished JSON. Budget output and split on truncation.
- Generic errors hid the cause. Store failure codes, finish reasons, and token counts.
- Retries, duplicate requests and late responses created duplicate results or charges. Use attempt IDs, idempotency keys, and ignore superseded attempts.
- Browser-driven processing depended on the browser staying alive. Keep the runner outside UI components, use workers, locks and Wake Lock, and reconcile saved state on return.
- A cancel overwrote a completed run, and stale "running" states stayed. The saved run record is authoritative.
- Reports disappeared after tab changes or reload. Results and reports are saved to Supabase and restored.
- Source previews failed on another device. Handle "source not on this device" gracefully while keeping the report readable.
- Old and new document paths coexisted. Keep one path.
- The AI claimed clauses were missing when they existed elsewhere. Needs document-wide context.
- Duplicated findings, over-rated severity, wrong checklists, unsupported numbers in rewrites. Needs the quality rules above.
- "All chunks processed" read as "fully reviewed". Report coverage honestly.
- Comparison by similarly numbered batches missed reordered clauses. Use embedding alignment plus verification.
- Mock tests passed, but real-provider runs exposed new failures. Test with the real provider and real documents.

## 11. Lesson from a reference project (LexMatter)
Its pipeline (browser extraction, chunking, browser embeddings, retrieval, OpenRouter analysis) is close to this one. Its strength is **code-side verification**: code checks chunk IDs and exact quotes, code decides match, conflict, or gap, and unverified summary sentences are dropped. Its weaknesses are retrieval-only analysis (it can miss clauses), English-only OCR, embeddings and keyword search, and no coverage ledger. It also never stores the original, so it cannot preview the source. Borrow the verification approach and avoid the weaknesses.

## 12. Known risks and limits
- **The browser must stay open for the whole run**, not only ingestion. A 500-page analysis takes roughly 25-45 minutes with about 500 calls. Closing the tab, sleep, or suspension pauses processing. No unattended or overnight runs.
- **IndexedDB can be cleared or evicted**, and has quotas. Request persistent storage and handle loss gracefully.
- **Weak laptops** are slow at in-browser OCR and embeddings, and local vector search over thousands of chunks needs a worker.
- **Documents are tied to one device.** Cross-device work needs re-import. Comparing documents needs both in one browser.
- **The proxy is a limit point:** wall clock, CPU, memory, and cold starts apply per call. Keep payloads small and tasks small.
- **Small embedding models** are weaker on Marathi legal text. Test retrieval on real contracts.
- **Law applicability is not verified by citation alone.**
- Document and question vectors must come from the same model and version.
- Local confidential data depends on device security.

## 13. Build approach
- Prove the pipeline first with a **small test harness** (separate file), then build the full app on it. The harness code should be modular (`ingest/`, `runner/`, `tasks/`, `retrieval/`) so the final app can reuse it.
- Development uses opencode with an OpenRouter key. Each prompt covers **one goal** and has a "Done when" check the user can run.
- Suggested order: IndexedDB storage layer, ingestion, chunking, the AI proxy and `runTask`, the browser runner with retries and splitting, progress view, embeddings and local search, roll-up and coverage ledger, custom-prompt job, OCR and page review, quality tests. Then the four modules, the law library, auth and RLS, results sync and restore, and DOCX support.
- Quality is measured against a fixed test set of real contracts with planted facts and lawyer-marked answers, run on the real provider.

## 14. Working preferences
- Keep chat answers concise to save tokens. Prompts written for the coding tool can be as detailed as needed.
- One clean goal per prompt.
- Explain each code change. Avoid applying blind fixes.

## 15. Open decisions
- Where the firm's law library lives (Supabase pgvector or a pack in IndexedDB) and its update process.
- Exact multilingual embedding model, and browser versus proxy embeddings.
- The local keyword index and its Marathi/Hindi tokenizer.
- Whether to encrypt IndexedDB data at rest.
- The runner's concurrency level, and how to detect and recover "uncertain" tasks.
- Severity rubric and the document and section classification scheme.
- Whether to add DOCX input.
- Final model choices for analysis, drafting, and chat.
- Whether a server runner for unattended runs is needed later.
