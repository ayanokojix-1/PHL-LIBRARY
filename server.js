const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Readable } = require("stream");
const { uploadToChannel, getFileUrl } = require("./telegram");
const { gdrivePreviewUrl, gdriveDownloadUrl } = require("./gdrive");
const pool = require("./db");
const migrate = require("./migrate");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB — Telegram Bot API limit
});

app.get("/", (req, res) => {
    res.json({ message: "University of Ibadan — Philosophy Department Library API" });
});

// Upload a document
app.post("/documents", upload.single("file"), async (req, res) => {
    try {
        const { title, description, course_code, level, type, uploaded_by, storage, gdrive_url } = req.body;

        if (!title) return res.status(400).json({ message: "Title is required" });

        const provider = storage === "gdrive" ? "gdrive" : "telegram";
        let insertQuery, insertParams;

        if (provider === "gdrive") {
            if (!gdrive_url) return res.status(400).json({ message: "Google Drive link is required" });

            insertQuery = `
                INSERT INTO documents
                    (title, description, course_code, level, type, uploaded_by,
                     storage_provider, gdrive_web_view_link, gdrive_web_content_link)
                VALUES ($1,$2,$3,$4,$5,$6,'gdrive',$7,$8)
                RETURNING *`;
            insertParams = [
                title, description || null, course_code || null, level || null,
                type || "general", uploaded_by || null,
                gdrivePreviewUrl(gdrive_url), gdriveDownloadUrl(gdrive_url),
            ];
        } else {
            if (!req.file) return res.status(400).json({ message: "No file uploaded" });

            const fileId = await uploadToChannel(req.file.buffer, req.file.originalname);
            insertQuery = `
                INSERT INTO documents
                    (title, description, course_code, level, type, telegram_file_id, filename, file_size, uploaded_by,
                     storage_provider)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'telegram')
                RETURNING *`;
            insertParams = [
                title, description || null, course_code || null, level || null,
                type || "general", fileId, req.file.originalname, req.file.size, uploaded_by || null,
            ];
        }

        const { rows } = await pool.query(insertQuery, insertParams);
        res.status(201).json({ document: rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Upload failed" });
    }
});

// Search documents (trigram — supports partial, mid-word matches)
app.get("/documents/search", async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ message: "Query param 'q' is required" });

        const { rows } = await pool.query(
            `SELECT id, title, description, course_code, level, type, uploaded_by, file_size, download_count, view_count, created_at
             FROM documents
             WHERE title % $1 OR title ILIKE $2
                OR course_code % $1 OR course_code ILIKE $2
             ORDER BY similarity(title, $1) DESC
             LIMIT 20`,
            [q, `%${q}%`]
        );

        res.json({ results: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Search failed" });
    }
});

// Recent uploads
app.get("/documents/recent", async (_req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, title, description, course_code, level, type, uploaded_by, file_size, download_count, view_count, created_at
             FROM documents
             ORDER BY created_at DESC
             LIMIT 20`
        );
        res.json({ documents: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Could not fetch recent documents" });
    }
});

// Get single document (share link profile)
app.get("/documents/:id", async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, title, description, course_code, level, type, uploaded_by, file_size, download_count, view_count, created_at
             FROM documents WHERE id = $1`,
            [req.params.id]
        );

        if (!rows.length) return res.status(404).json({ message: "Document not found" });

        res.json({ document: rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Could not fetch document" });
    }
});

// Stream — serve inline (redirect for GDrive, proxy for Telegram)
app.get("/documents/:id/stream", async (req, res) => {
    try {
        const { rows } = await pool.query(
            `UPDATE documents SET view_count = view_count + 1
             WHERE id = $1 RETURNING telegram_file_id, filename, storage_provider, gdrive_web_view_link`,
            [req.params.id]
        );

        if (!rows.length) return res.status(404).json({ message: "Document not found" });

        const doc = rows[0];
        console.log(doc)
        if (doc.storage_provider === "gdrive") {
            return res.redirect(gdrivePreviewUrl(doc.gdrive_web_view_link));
        }

        const fileUrl = await getFileUrl(doc.telegram_file_id);
        const upstream = await fetch(fileUrl);

        if (!upstream.ok) return res.status(502).json({ message: "Could not fetch document" });

        const ext = (doc.filename || "").split(".").pop().toLowerCase();
        const contentTypes = {
            pdf: "application/pdf",
            doc: "application/msword",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ppt: "application/vnd.ms-powerpoint",
            pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        };
        res.setHeader("Content-Type", contentTypes[ext] || "application/octet-stream");
        res.setHeader("Content-Disposition", "inline");

        Readable.fromWeb(upstream.body).pipe(res);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Stream failed" });
    }
});

// Download — serve as attachment (redirect for GDrive, proxy for Telegram)
app.get("/documents/:id/download", async (req, res) => {
    try {
        const { rows } = await pool.query(
            `UPDATE documents SET download_count = download_count + 1
             WHERE id = $1 RETURNING telegram_file_id, title, filename, storage_provider, gdrive_web_content_link`,
            [req.params.id]
        );

        if (!rows.length) return res.status(404).json({ message: "Document not found" });

        const doc = rows[0];

        if (doc.storage_provider === "gdrive") {
            return res.redirect(doc.gdrive_web_content_link);
        }

        const fileUrl = await getFileUrl(doc.telegram_file_id);
        const upstream = await fetch(fileUrl);

        if (!upstream.ok) return res.status(502).json({ message: "Could not fetch document" });

        res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${doc.filename || doc.title}"`);

        Readable.fromWeb(upstream.body).pipe(res);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Download failed" });
    }
});

migrate().then(() => {
    app.listen(3000, () => {
        console.log("Server running on port 3000");
    });
}).catch(err => {
    console.error("Migration failed, server not started:", err.message);
    process.exit(1);
});
