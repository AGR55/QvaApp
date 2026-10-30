import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

// Fixed, synthetic history; never opens the application's database.
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE mutation_intents(intent_id TEXT PRIMARY KEY, operation_uuid TEXT, kind TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, workflow_id TEXT);
  CREATE INDEX idx_apply_intent_offer ON mutation_intents(operation_uuid, created_at DESC) WHERE kind='apply';
  CREATE INDEX idx_mutation_intents_workflow_state ON mutation_intents(workflow_id,state,created_at);
  BEGIN`);
const insert = db.prepare("INSERT INTO mutation_intents VALUES (?, ?, ?, ?, ?, ?)");
for (let i = 0; i < 100_000; i++) insert.run(String(i), `offer-${i}`, "apply", i % 1000 === 0 ? "uncertain" : "confirmed", i, null);
db.exec("COMMIT");
const sql = "SELECT 1 FROM mutation_intents WHERE operation_uuid = ? AND state IN ('submitted', 'uncertain') AND intent_id != ? LIMIT 1";
function measure() {
  const query = db.prepare(sql);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("absent", "").map(row => row.detail);
  const start = performance.now();
  for (let i = 0; i < 500; i++) query.get(`absent-${i}`, "");
  return { plan, millisecondsFor500: performance.now() - start };
}
console.log("before", measure());
db.exec("CREATE INDEX idx_mutation_intents_unresolved_offer ON mutation_intents(operation_uuid, intent_id) WHERE state IN ('submitted', 'uncertain')");
console.log("after", measure());
db.close();
