const { pool } = require("./src/configs/db");

async function check() {
  try {
    const res = await pool.query(`
      SELECT id, file_name, document_type, ocr_status, 
             structured_extracted_data->'documentInfo'->>'documentType' as extracted_doc_type,
             structured_extracted_data->'documentInfo'->>'rawClassification' as raw_class,
             created_at
      FROM documents
      ORDER BY created_at DESC
      LIMIT 10;
    `);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error("DB Query error:", err);
  } finally {
    await pool.end();
  }
}

check();
