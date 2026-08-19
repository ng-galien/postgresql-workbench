// Schema Sync owns a dedicated one-worker lane, VS Code profile, database and index. Keeping this
// destructive state machine out of the Core lane prevents listener or DDL cleanup from invalidating
// unrelated index consumers.
import "./workbench/schema-sync.spec.js";
