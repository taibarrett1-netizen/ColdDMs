/**
 * Supabase layer for Cold DM (handoff from setter dashboard).
 * All tables use client_id (UUID). Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const CLIENT_ID_FILE = path.join(process.cwd(), '.cold_dm_client_id');

let _client = null;

function getSupabase() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _client = createClient(url, key);
  return _client;
}

function isSupabaseConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getClientId() {
  if (process.env.COLD_DM_CLIENT_ID) return process.env.COLD_DM_CLIENT_ID;
  try {
    if (fs.existsSync(CLIENT_ID_FILE)) {
      return fs.readFileSync(CLIENT_ID_FILE, 'utf8').trim();
    }
  } catch (e) {}
  return null;
}

function setClientId(clientId) {
  if (!clientId) return;
  try {
    fs.writeFileSync(CLIENT_ID_FILE, String(clientId).trim(), 'utf8');
  } catch (e) {}
}

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeUsername(username) {
  const u = String(username).trim();
  return u.startsWith('@') ? u.slice(1) : u;
}

async function getSettings(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return null;
  const { data, error } = await sb
    .from('cold_dm_settings')
    .select('*')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getMessageTemplates(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return [];
  const { data, error } = await sb
    .from('cold_dm_message_templates')
    .select('message_text')
    .eq('client_id', clientId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => r.message_text).filter(Boolean);
}

async function getLeads(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return [];
  const { data, error } = await sb
    .from('cold_dm_leads')
    .select('username')
    .eq('client_id', clientId);
  if (error) throw error;
  return (data || []).map((r) => normalizeUsername(r.username)).filter(Boolean);
}

async function getSession(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return null;
  const { data, error } = await sb
    .from('cold_dm_instagram_sessions')
    .select('session_data, instagram_username')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function saveSession(clientId, sessionData, instagramUsername) {
  const sb = getSupabase();
  if (!sb || !clientId) throw new Error('Supabase or clientId missing');
  const { error } = await sb
    .from('cold_dm_instagram_sessions')
    .upsert(
      {
        client_id: clientId,
        session_data: sessionData,
        instagram_username: instagramUsername || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id' }
    );
  if (error) throw error;
}

async function alreadySent(clientId, username) {
  const sb = getSupabase();
  if (!sb || !clientId) return false;
  const u = normalizeUsername(username);
  const { data, error } = await sb
    .from('cold_dm_sent_messages')
    .select('id')
    .eq('client_id', clientId)
    .eq('username', u)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

async function logSentMessage(clientId, username, message, status = 'success') {
  const sb = getSupabase();
  if (!sb || !clientId) throw new Error('Supabase or clientId missing');
  const u = normalizeUsername(username);
  const date = getToday();
  const { error: insertErr } = await sb.from('cold_dm_sent_messages').insert({
    client_id: clientId,
    username: u,
    message: message || null,
    status,
  });
  if (insertErr) throw insertErr;

  const { data: existing } = await sb
    .from('cold_dm_daily_stats')
    .select('total_sent, total_failed')
    .eq('client_id', clientId)
    .eq('date', date)
    .maybeSingle();

  if (existing) {
    const { error: updateErr } = await sb
      .from('cold_dm_daily_stats')
      .update(
        status === 'success'
          ? { total_sent: existing.total_sent + 1 }
          : { total_failed: existing.total_failed + 1 }
      )
      .eq('client_id', clientId)
      .eq('date', date);
    if (updateErr) throw updateErr;
  } else {
    const { error: insertStatErr } = await sb.from('cold_dm_daily_stats').insert({
      client_id: clientId,
      date,
      total_sent: status === 'success' ? 1 : 0,
      total_failed: status === 'failed' ? 1 : 0,
    });
    if (insertStatErr) throw insertStatErr;
  }
}

async function getDailyStats(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return { date: getToday(), total_sent: 0, total_failed: 0 };
  const date = getToday();
  const { data, error } = await sb
    .from('cold_dm_daily_stats')
    .select('total_sent, total_failed')
    .eq('client_id', clientId)
    .eq('date', date)
    .maybeSingle();
  if (error) throw error;
  return data
    ? { date, total_sent: data.total_sent, total_failed: data.total_failed }
    : { date, total_sent: 0, total_failed: 0 };
}

async function getHourlySent(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return 0;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await sb
    .from('cold_dm_sent_messages')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .gte('sent_at', oneHourAgo);
  if (error) throw error;
  return count || 0;
}

async function getControl(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return null;
  const { data, error } = await sb
    .from('cold_dm_control')
    .select('pause')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data ? String(data.pause) : null;
}

async function setControl(clientId, pause) {
  const sb = getSupabase();
  if (!sb || !clientId) throw new Error('Supabase or clientId missing');
  const { error } = await sb
    .from('cold_dm_control')
    .upsert(
      {
        client_id: clientId,
        pause: pause === 1 || pause === '1' ? 1 : 0,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id' }
    );
  if (error) throw error;
}

async function getRecentSent(clientId, limit = 50) {
  const sb = getSupabase();
  if (!sb || !clientId) return [];
  const { data, error } = await sb
    .from('cold_dm_sent_messages')
    .select('username, message, sent_at, status')
    .eq('client_id', clientId)
    .order('sent_at', { ascending: false })
    .limit(Math.min(limit, 200));
  if (error) throw error;
  return data || [];
}

async function getSentUsernames(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return new Set();
  const { data, error } = await sb
    .from('cold_dm_sent_messages')
    .select('username')
    .eq('client_id', clientId);
  if (error) throw error;
  return new Set((data || []).map((r) => normalizeUsername(r.username)));
}

async function clearFailedAttempts(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return 0;
  const date = getToday();
  const { data: deleted } = await sb
    .from('cold_dm_sent_messages')
    .delete()
    .eq('client_id', clientId)
    .eq('status', 'failed')
    .select('id');
  const count = deleted?.length ?? 0;
  const { data: row } = await sb
    .from('cold_dm_daily_stats')
    .select('id')
    .eq('client_id', clientId)
    .eq('date', date)
    .maybeSingle();
  if (row) {
    await sb.from('cold_dm_daily_stats').update({ total_failed: 0 }).eq('client_id', clientId).eq('date', date);
  }
  return count;
}

async function updateSettingsInstagramUsername(clientId, instagramUsername) {
  const sb = getSupabase();
  if (!sb || !clientId) return;
  await sb.from('cold_dm_settings').update({ instagram_username: instagramUsername, updated_at: new Date().toISOString() }).eq('client_id', clientId);
}

module.exports = {
  getSupabase,
  isSupabaseConfigured,
  getClientId,
  setClientId,
  getToday,
  normalizeUsername,
  getSettings,
  getMessageTemplates,
  getLeads,
  getSession,
  saveSession,
  alreadySent,
  logSentMessage,
  getDailyStats,
  getHourlySent,
  getControl,
  setControl,
  getRecentSent,
  getSentUsernames,
  clearFailedAttempts,
  updateSettingsInstagramUsername,
};
