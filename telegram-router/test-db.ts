import postgres from 'postgres';

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("❌ Missing SUPABASE_DB_URL (or legacy DATABASE_URL)");
  process.exit(1);
}

const sql = postgres(dbUrl);

try {
  const result = await sql`SELECT COUNT(*) as count FROM users`;
  console.log("✅ Database connected:", result[0].count, "users");

  const assistants = await sql`
    SELECT
      a.id as assistant_id,
      a.assistant_bot_id,
      r.runtime_provider,
      r.runtime_ref,
      r.status
    FROM assistants a
    LEFT JOIN runtime_instances r
      ON r.assistant_id = a.id
      AND r.scope = 'assistant'
    ORDER BY a.id
    LIMIT 5
  `;

  console.log("\n📦 Sample assistants:");
  console.table(assistants);

  process.exit(0);
} catch (error) {
  console.error("❌ Database error:", error);
  process.exit(1);
}
