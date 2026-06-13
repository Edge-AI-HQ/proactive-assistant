-- /api/memory (mirror panel) lists active memories ordered by created_at DESC
-- — that's the default order_by in MemoryRepository.list_active and the only
-- order the frontend's "load more" pages through (GoalsView loadMoreMemories).
--
-- The table had (user_id, status, quality DESC) and (user_id, subject,
-- created_at DESC), but nothing serving (user_id, status) + created_at order.
-- So the page query had to read every active row and Sort it — and since the
-- rows were wide (SELECT * pulled the 1536-d embedding) that sort spilled to
-- disk on large memory sets. The list_active rewrite (same change set) drops
-- the embedding from the projection and counts separately; this index closes
-- the loop so the page itself is an index-ordered top-N instead of a full
-- sort, and the active-count is an index-only scan.
CREATE INDEX idx_pai_memory_status_created
  ON pai_memory (user_id, status, created_at DESC);
