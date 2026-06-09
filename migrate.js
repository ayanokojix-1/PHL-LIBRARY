const pool = require("./db");

async function migrate() {
    const client = await pool.connect();
    try {
        await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");

        await client.query(`
            CREATE TABLE IF NOT EXISTS documents (
                id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                title            TEXT NOT NULL,
                description      TEXT,
                course_code      TEXT,
                level            TEXT,
                type             TEXT DEFAULT 'general',
                file_url         TEXT,
                public_id        TEXT,
                telegram_file_id TEXT,
                filename         TEXT,
                file_size        INTEGER,
                uploaded_by      TEXT,
                download_count   INTEGER DEFAULT 0,
                view_count       INTEGER DEFAULT 0,
                created_at       TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // Add any missing columns to existing tables
        const alterations = [
            "ALTER TABLE documents ALTER COLUMN file_url DROP NOT NULL",
            "ALTER TABLE documents ALTER COLUMN public_id DROP NOT NULL",
            "ALTER TABLE documents ADD COLUMN IF NOT EXISTS telegram_file_id TEXT",
            "ALTER TABLE documents ADD COLUMN IF NOT EXISTS filename TEXT",
            "ALTER TABLE documents ADD COLUMN IF NOT EXISTS view_count INTEGER DEFAULT 0",
            "ALTER TABLE documents ADD COLUMN IF NOT EXISTS download_count INTEGER DEFAULT 0",
            "ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_provider TEXT DEFAULT 'telegram'",
            "ALTER TABLE documents ADD COLUMN IF NOT EXISTS gdrive_file_id TEXT",
            "ALTER TABLE documents ADD COLUMN IF NOT EXISTS gdrive_web_view_link TEXT",
            "ALTER TABLE documents ADD COLUMN IF NOT EXISTS gdrive_web_content_link TEXT",
        ];

        for (const sql of alterations) {
            await client.query(sql).catch(() => {});
        }

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_documents_trgm_title
            ON documents USING gin (title gin_trgm_ops)
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_documents_trgm_course
            ON documents USING gin (course_code gin_trgm_ops)
        `);

        console.log("DB ready.");
    } finally {
        client.release();
    }
}

module.exports = migrate;

if (require.main === module) {
    migrate().then(() => pool.end()).catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}
