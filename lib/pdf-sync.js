// lib/pdf-sync.js — Sync library PDFs via Supabase Storage
//
// Uploads/downloads PDF files so the library stays in sync between
// Chrome extension and Electron app. Uses Supabase Storage for binary
// PDF data and a library_pdfs table for metadata/dedup.

const SUPABASE_URL = 'https://lfvbrrxnjwanbniaegnf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmdmJycnhuandhbmJuaWFlZ25mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2NzAxMDYsImV4cCI6MjA4ODI0NjEwNn0.6NzXByK1y8FP-iCqYx6GCiuG6DsIvXpbkyqiCX_R1Os';

function authHeaders(token) {
  return {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${token}`
  };
}

// List all PDFs the user has uploaded to Supabase
export async function listRemotePdfs(token, userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/library_pdfs?user_id=eq.${userId}&select=page_key,file_hash,byte_size,title,author,file_name,page_count,word_count,tags,storage_path,uploaded_at`,
    { headers: authHeaders(token) }
  );
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`List remote PDFs failed: ${res.status} ${err}`);
  }
  return res.json();
}

// Upload PDF to Supabase Storage and register metadata
export async function uploadPdf(token, userId, { pageKey, fileHash, byteSize, title, author, fileName, pageCount, wordCount, tags, pdfData }) {
  const storagePath = `${userId}/${fileHash}-${byteSize}.pdf`;

  // Upload binary to Supabase Storage
  const uploadRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/library/${storagePath}`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'Content-Type': 'application/pdf',
        'x-upsert': 'true'
      },
      body: pdfData
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text().catch(() => '');
    throw new Error(`Storage upload failed: ${uploadRes.status} ${err}`);
  }

  // Upsert metadata in library_pdfs table
  const metaRes = await fetch(
    `${SUPABASE_URL}/rest/v1/library_pdfs`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(token),
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        user_id: userId,
        page_key: pageKey,
        file_hash: fileHash || '',
        byte_size: byteSize || 0,
        title: title || '',
        author: author || '',
        file_name: fileName || '',
        page_count: pageCount || 0,
        word_count: wordCount || 0,
        tags: tags || [],
        storage_path: storagePath,
        updated_at: new Date().toISOString()
      })
    }
  );

  if (!metaRes.ok) {
    const err = await metaRes.text().catch(() => '');
    throw new Error(`Metadata upsert failed: ${metaRes.status} ${err}`);
  }

  return storagePath;
}

// Download PDF binary from Supabase Storage
export async function downloadPdf(token, storagePath) {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/library/${storagePath}`,
    { headers: authHeaders(token) }
  );
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return res.arrayBuffer();
}
