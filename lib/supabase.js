// Supabase client for Marginalia sharing + auth
// Uses raw fetch (no SDK needed) against the Supabase REST + Auth APIs.

const SUPABASE_URL = 'https://lfvbrrxnjwanbniaegnf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxmdmJycnhuandhbmJuaWFlZ25mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2NzAxMDYsImV4cCI6MjA4ODI0NjEwNn0.6NzXByK1y8FP-iCqYx6GCiuG6DsIvXpbkyqiCX_R1Os';

const SHARE_HASH_PREFIX = 'marginalia-share=';

// ── Session management ──────────────────────────────────────────────

async function getSession() {
  const { ocSupabaseSession } = await chrome.storage.local.get('ocSupabaseSession');
  return ocSupabaseSession || null;
}

function saveSessionFromResponse(data) {
  return chrome.storage.local.set({
    ocSupabaseSession: {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      user: data.user
    }
  });
}

async function clearSession() {
  await chrome.storage.local.remove('ocSupabaseSession');
}

// Returns { token, userId } or null. Refreshes if expired.
async function getAuthContext() {
  const session = await getSession();
  if (!session) return null;

  const expiresAt = session.expires_at || 0;
  if (Date.now() / 1000 > expiresAt - 60) {
    const refreshed = await refreshToken(session.refresh_token);
    if (refreshed) return { token: refreshed.access_token, userId: refreshed.user.id };
    await clearSession();
    return null;
  }

  return { token: session.access_token, userId: session.user.id };
}

// ── Auth API ────────────────────────────────────────────────────────

export async function signUp(email, password, displayName) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY
    },
    body: JSON.stringify({
      email,
      password,
      data: { display_name: displayName }
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign up failed');

  if (data.access_token) {
    await saveSessionFromResponse(data);
  }

  return data;
}

export async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY
    },
    body: JSON.stringify({ email, password })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign in failed');

  await saveSessionFromResponse(data);
  return data;
}

async function refreshToken(token) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ refresh_token: token })
    });

    if (!res.ok) return null;
    const data = await res.json();
    await saveSessionFromResponse(data);
    return data;
  } catch {
    return null;
  }
}

export async function signOut() {
  const auth = await getAuthContext();
  if (auth) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auth.token}`,
          'apikey': SUPABASE_ANON_KEY
        }
      });
    } catch {}
  }
  await clearSession();
}

export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;

  // Validate token is still usable (refreshes if needed as side effect)
  const auth = await getAuthContext();
  if (!auth) return null;

  return session.user;
}

// ── Sharing API ─────────────────────────────────────────────────────

function generateShareCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  const arr = crypto.getRandomValues(new Uint8Array(8));
  for (const byte of arr) code += chars[byte % chars.length];
  return code;
}

// Share annotations for a page. Returns { shareCode, updated }.
// If already shared by this user for this pageKey, updates the existing share.
export async function shareAnnotations({ pageKey, title, author, url, notes, tags, highlights }) {
  const auth = await getAuthContext();
  if (!auth) throw new Error('Not signed in — sign in from Settings to share annotations');

  const { token, userId } = auth;

  // Check for existing share by this user for this pageKey
  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/shared_pages?user_id=eq.${userId}&page_key=eq.${encodeURIComponent(pageKey)}&select=id,share_code`,
    {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`
      }
    }
  );

  const existing = await existingRes.json();

  if (existing.length > 0) {
    // Update existing share
    const shareCode = existing[0].share_code;
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/shared_pages?id=eq.${existing[0].id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          title, author, url, notes,
          tags: tags || [],
          highlights: highlights || [],
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Failed to update share');
    }

    return { shareCode, updated: true };
  }

  // Create new share
  const shareCode = generateShareCode();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/shared_pages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      share_code: shareCode,
      user_id: userId,
      page_key: pageKey,
      title, author, url, notes,
      tags: tags || [],
      highlights: highlights || []
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || 'Failed to share');
  }

  return { shareCode, updated: false };
}

// Fetch a shared page by share code (no auth needed)
export async function getSharedPage(shareCode) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shared_pages?share_code=eq.${encodeURIComponent(shareCode)}&select=*,profiles(display_name)`,
    {
      headers: {
        'apikey': SUPABASE_ANON_KEY
      }
    }
  );

  if (!res.ok) throw new Error('Failed to fetch shared page');
  const data = await res.json();
  if (!data.length) throw new Error('Share not found');
  return data[0];
}

// Get all shares by the current user
export async function getMyShares() {
  const auth = await getAuthContext();
  if (!auth) return [];

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shared_pages?user_id=eq.${auth.userId}&select=id,share_code,title,page_key,url,created_at,updated_at&order=updated_at.desc`,
    {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${auth.token}`
      }
    }
  );

  if (!res.ok) return [];
  return res.json();
}

// Delete a share
export async function deleteShare(shareId) {
  const auth = await getAuthContext();
  if (!auth) throw new Error('Not signed in');

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shared_pages?id=eq.${shareId}`,
    {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${auth.token}`
      }
    }
  );

  if (!res.ok) throw new Error('Failed to delete share');
}

// Build the share URL for a given code.
// Web pages: append #marginalia-share=CODE to the original URL (content script detects & overlays)
// Library PDFs: fall back to the extension's shared.html viewer
export function getShareUrl(shareCode, originalUrl) {
  if (!originalUrl || originalUrl.startsWith('library:')) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(`shared.html?code=${shareCode}`);
    }
    return `shared.html?code=${shareCode}`;
  }

  const url = new URL(originalUrl);
  url.hash = `${SHARE_HASH_PREFIX}${shareCode}`;
  return url.toString();
}
