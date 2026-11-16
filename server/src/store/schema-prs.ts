/** One row holding the last PR list read from GitHub, so it shows at once after a restart. */
export const PR_LIST_CACHE = `
CREATE TABLE pr_list_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
`
