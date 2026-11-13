-- Document-aware chat. A message may be about one document (the id is the IndexedDB document id,
-- so it is text and has no foreign key). Assistant messages record which mode answered and the
-- citation fields (page, clause, quote) so a reloaded chat keeps its sources. Chat-originated
-- runs are tagged so they can be told apart from analysis runs (analysis runs keep source null).

alter table chat_messages add column if not exists document_id text;
alter table chat_messages add column if not exists document_name text;
alter table chat_messages add column if not exists mode text
  check (mode in ('saved', 'retrieval', 'whole'));
alter table chat_messages add column if not exists citations jsonb;

alter table runs add column if not exists source text;
