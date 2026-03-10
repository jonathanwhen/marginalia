// lib/collab.js - Collaborative annotations API
// Uses same Supabase REST pattern as lib/supabase.js (raw fetch, no SDK).

import { SUPABASE_URL, SUPABASE_ANON_KEY, getAuthContext } from './supabase.js';

// Standard headers for authenticated Supabase REST requests
function authHeaders(token) {
  return {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

// ── Create a collab page for a URL ────────────────────────────────────
// Also adds the owner as the first member. Returns { collabPageId, inviteCode }.
export async function createCollabPage(token, userId, pageKey, pageUrl, pageTitle) {
  // Insert into collab_pages with Prefer: return=representation to get the generated id + invite_code
  const res = await fetch(`${SUPABASE_URL}/rest/v1/collab_pages`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Prefer': 'return=representation' },
    body: JSON.stringify({
      owner_id: userId,
      page_key: pageKey,
      page_url: pageUrl,
      page_title: pageTitle
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || 'Failed to create collab page');
  }

  const [page] = await res.json();

  // Add owner as a member so RLS membership queries include the owner
  const memberRes = await fetch(`${SUPABASE_URL}/rest/v1/collab_members`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      collab_page_id: page.id,
      user_id: userId,
      display_name: pageTitle // will be overwritten with actual name by caller
    })
  });

  if (!memberRes.ok) {
    // Non-fatal: the page was still created, owner can still use it via owner RLS policy
    console.warn('collab: failed to add owner as member', await memberRes.text());
  }

  return { collabPageId: page.id, inviteCode: page.invite_code };
}

// ── Join a collab page by invite code ─────────────────────────────────
// Returns { collabPageId, pageKey, pageUrl, pageTitle }.
export async function joinCollabPage(token, userId, inviteCode, displayName) {
  // Look up the collab page by invite_code
  const lookupRes = await fetch(
    `${SUPABASE_URL}/rest/v1/collab_pages?invite_code=eq.${encodeURIComponent(inviteCode)}&select=id,page_key,page_url,page_title`,
    { headers: authHeaders(token) }
  );

  if (!lookupRes.ok) throw new Error('Failed to look up invite code');
  const pages = await lookupRes.json();
  if (!pages.length) throw new Error('Invalid invite code');

  const page = pages[0];

  // Insert into collab_members (unique constraint prevents duplicates)
  const joinRes = await fetch(`${SUPABASE_URL}/rest/v1/collab_members`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      collab_page_id: page.id,
      user_id: userId,
      display_name: displayName || 'Anonymous'
    })
  });

  if (!joinRes.ok) {
    const err = await joinRes.json();
    // 409 / unique violation means already a member — treat as success
    if (!err.message?.includes('duplicate') && !err.message?.includes('unique')) {
      throw new Error(err.message || 'Failed to join collab page');
    }
  }

  return {
    collabPageId: page.id,
    pageKey: page.page_key,
    pageUrl: page.page_url,
    pageTitle: page.page_title
  };
}

// ── Push a highlight annotation to the collab page ────────────────────
// Uses upsert keyed on (collab_page_id, user_id, highlight->id) via the
// highlight's embedded id. Each highlight is a separate row.
export async function pushAnnotation(token, userId, collabPageId, displayName, highlight) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/collab_annotations`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      collab_page_id: collabPageId,
      user_id: userId,
      display_name: displayName,
      highlight
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || 'Failed to push annotation');
  }
}

// ── Pull all annotations for a collab page ────────────────────────────
// Returns [{ id, userId, displayName, highlight }].
export async function pullAnnotations(token, collabPageId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/collab_annotations?collab_page_id=eq.${collabPageId}&select=id,user_id,display_name,highlight&order=created_at.asc`,
    { headers: authHeaders(token) }
  );

  if (!res.ok) throw new Error('Failed to pull annotations');
  const rows = await res.json();
  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    displayName: r.display_name || 'Anonymous',
    highlight: r.highlight
  }));
}

// ── Delete an annotation ──────────────────────────────────────────────
export async function deleteAnnotation(token, annotationId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/collab_annotations?id=eq.${annotationId}`,
    { method: 'DELETE', headers: authHeaders(token) }
  );
  if (!res.ok) throw new Error('Failed to delete annotation');
}

// ── Get collab page for a URL (if user owns or is a member) ───────────
// Returns { collabPageId, inviteCode, isOwner } or null.
export async function getCollabForPage(token, userId, pageKey) {
  // Check if user owns a collab page for this pageKey
  const ownedRes = await fetch(
    `${SUPABASE_URL}/rest/v1/collab_pages?owner_id=eq.${userId}&page_key=eq.${encodeURIComponent(pageKey)}&select=id,invite_code`,
    { headers: authHeaders(token) }
  );
  if (ownedRes.ok) {
    const owned = await ownedRes.json();
    if (owned.length) {
      return { collabPageId: owned[0].id, inviteCode: owned[0].invite_code, isOwner: true };
    }
  }

  // Check if user is a member of any collab page for this pageKey
  // Need to query collab_members joined with collab_pages
  const memberRes = await fetch(
    `${SUPABASE_URL}/rest/v1/collab_members?user_id=eq.${userId}&select=collab_page_id,collab_pages!inner(id,invite_code,page_key)`,
    { headers: authHeaders(token) }
  );
  if (memberRes.ok) {
    const memberships = await memberRes.json();
    const match = memberships.find(m => m.collab_pages?.page_key === pageKey);
    if (match) {
      return {
        collabPageId: match.collab_pages.id,
        inviteCode: match.collab_pages.invite_code,
        isOwner: false
      };
    }
  }

  return null;
}

// ── Subscribe to annotation updates via polling ───────────────────────
// Polls every 5 seconds and calls onUpdate(annotations) with the full list.
// Returns an unsubscribe function.
export function subscribeToAnnotations(token, collabPageId, onUpdate) {
  let active = true;

  const poll = async () => {
    if (!active) return;
    try {
      const annotations = await pullAnnotations(token, collabPageId);
      if (active) onUpdate(annotations);
    } catch (e) {
      console.warn('collab poll failed:', e);
    }
  };

  const interval = setInterval(poll, 5000);
  return () => { active = false; clearInterval(interval); };
}
