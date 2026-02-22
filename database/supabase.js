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
    .select('id, session_data, instagram_username')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** All sessions for a client. Used when campaign has no assigned sessions. */
async function getSessions(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return [];
  const { data, error } = await sb
    .from('cold_dm_instagram_sessions')
    .select('id, session_data, instagram_username')
    .eq('client_id', clientId)
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Sessions to use for a campaign. If campaign has rows in cold_dm_campaign_instagram_sessions,
 * returns only those sessions; otherwise returns all client sessions.
 */
async function getSessionsForCampaign(clientId, campaignId) {
  const sb = getSupabase();
  if (!sb || !clientId || !campaignId) return [];
  try {
    const { data: assigned, error } = await sb
      .from('cold_dm_campaign_instagram_sessions')
      .select('instagram_session_id')
      .eq('campaign_id', campaignId);
    if (error || !assigned || assigned.length === 0) {
      return getSessions(clientId);
    }
    const ids = assigned.map((r) => r.instagram_session_id).filter(Boolean);
    if (ids.length === 0) return getSessions(clientId);
    const { data: sessions, error: sessErr } = await sb
      .from('cold_dm_instagram_sessions')
      .select('id, session_data, instagram_username')
      .eq('client_id', clientId)
      .in('id', ids)
      .order('id', { ascending: true });
    if (sessErr || !sessions?.length) return getSessions(clientId);
    return sessions;
  } catch (e) {
    return getSessions(clientId);
  }
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

async function logSentMessage(clientId, username, message, status = 'success', campaignId = null, messageGroupId = null) {
  const sb = getSupabase();
  if (!sb || !clientId) throw new Error('Supabase or clientId missing');
  const u = normalizeUsername(username);
  const date = getToday();
  const insertPayload = {
    client_id: clientId,
    username: u,
    message: message || null,
    status,
  };
  if (campaignId) insertPayload.campaign_id = campaignId;
  if (messageGroupId) insertPayload.message_group_id = messageGroupId;
  const { error: insertErr } = await sb.from('cold_dm_sent_messages').insert(insertPayload);
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

// --- Scraper session ---
async function getScraperSession(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return null;
  const { data, error } = await sb
    .from('cold_dm_scraper_sessions')
    .select('session_data, instagram_username')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function saveScraperSession(clientId, sessionData, instagramUsername) {
  const sb = getSupabase();
  if (!sb || !clientId) throw new Error('Supabase or clientId missing');
  const { error } = await sb
    .from('cold_dm_scraper_sessions')
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

// --- Platform scraper sessions (rotation pool) ---
async function getPlatformScraperSessions() {
  const sb = getSupabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from('cold_dm_platform_scraper_sessions')
    .select('id, session_data, instagram_username, daily_actions_limit')
    .order('id', { ascending: true });
  if (error) return [];
  return data || [];
}

async function getPlatformScraperSessionById(id) {
  if (!id) return null;
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from('cold_dm_platform_scraper_sessions')
    .select('id, session_data, instagram_username')
    .eq('id', id)
    .maybeSingle();
  if (error) return null;
  return data;
}

async function getPlatformScraperUsageToday(sessionIds) {
  if (!sessionIds || sessionIds.length === 0) return {};
  const sb = getSupabase();
  if (!sb) return {};
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from('cold_dm_scraper_daily_usage')
    .select('platform_scraper_session_id, actions_count')
    .in('platform_scraper_session_id', sessionIds)
    .eq('usage_date', today);
  if (error) return {};
  const map = {};
  for (const row of data || []) {
    map[row.platform_scraper_session_id] = row.actions_count || 0;
  }
  return map;
}

async function pickScraperSessionForJob(clientId) {
  const sessions = await getPlatformScraperSessions();
  if (sessions.length === 0) {
    const clientSession = await getScraperSession(clientId);
    if (clientSession) return { source: 'client', session: clientSession, platformSessionId: null };
    return null;
  }
  const sessionIds = sessions.map((s) => s.id);
  const usage = await getPlatformScraperUsageToday(sessionIds);
  const candidates = sessions.filter((s) => (usage[s.id] || 0) < (s.daily_actions_limit || 500));
  if (candidates.length === 0) {
    const clientSession = await getScraperSession(clientId);
    if (clientSession) return { source: 'client', session: clientSession, platformSessionId: null };
    return null;
  }
  candidates.sort((a, b) => (usage[a.id] || 0) - (usage[b.id] || 0));
  const picked = candidates[0];
  return {
    source: 'platform',
    session: { session_data: picked.session_data, instagram_username: picked.instagram_username },
    platformSessionId: picked.id,
  };
}

async function recordScraperActions(platformSessionId, count) {
  if (!platformSessionId || count <= 0) return;
  const sb = getSupabase();
  if (!sb) return;
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await sb
    .from('cold_dm_scraper_daily_usage')
    .select('id, actions_count')
    .eq('platform_scraper_session_id', platformSessionId)
    .eq('usage_date', today)
    .maybeSingle();
  const newCount = (existing?.actions_count || 0) + count;
  if (existing) {
    await sb
      .from('cold_dm_scraper_daily_usage')
      .update({ actions_count: newCount, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
  } else {
    await sb.from('cold_dm_scraper_daily_usage').insert({
      platform_scraper_session_id: platformSessionId,
      usage_date: today,
      actions_count: newCount,
    });
  }
}

async function savePlatformScraperSession(sessionData, instagramUsername, dailyActionsLimit = 500) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase not configured');
  const username = (instagramUsername || '').trim().replace(/^@/, '');
  if (!username) throw new Error('Instagram username required');
  const { data, error } = await sb
    .from('cold_dm_platform_scraper_sessions')
    .upsert(
      {
        session_data: sessionData,
        instagram_username: username,
        daily_actions_limit: Math.max(1, parseInt(dailyActionsLimit, 10) || 500),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'instagram_username' }
    )
    .select('id')
    .single();
  if (error) {
    const { error: insertErr } = await sb.from('cold_dm_platform_scraper_sessions').insert({
      session_data: sessionData,
      instagram_username: username,
      daily_actions_limit: Math.max(1, parseInt(dailyActionsLimit, 10) || 500),
    });
    if (insertErr) throw insertErr;
    return;
  }
  return data?.id;
}

// --- Scrape jobs ---
async function createScrapeJob(clientId, targetUsername, leadGroupId = null, scrapeType = 'followers', postUrls = null, platformScraperSessionId = null) {
  const sb = getSupabase();
  if (!sb || !clientId) throw new Error('Supabase or clientId missing');
  const payload = {
    client_id: clientId,
    target_username: targetUsername,
    status: 'running',
    scraped_count: 0,
    started_at: new Date().toISOString(),
  };
  if (leadGroupId) payload.lead_group_id = leadGroupId;
  if (scrapeType) payload.scrape_type = scrapeType;
  if (postUrls && Array.isArray(postUrls) && postUrls.length) payload.post_urls = postUrls;
  if (platformScraperSessionId) payload.platform_scraper_session_id = platformScraperSessionId;
  const { data, error } = await sb
    .from('cold_dm_scrape_jobs')
    .insert(payload)
    .select('id')
    .single();
  if (error) throw error;
  return data?.id;
}

async function updateScrapeJob(jobId, updates) {
  const sb = getSupabase();
  if (!sb || !jobId) throw new Error('Supabase or jobId missing');
  const payload = { ...updates };
  if (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'cancelled') {
    payload.finished_at = new Date().toISOString();
  }
  const { error } = await sb.from('cold_dm_scrape_jobs').update(payload).eq('id', jobId);
  if (error) throw error;
}

async function getScrapeJob(jobId) {
  const sb = getSupabase();
  if (!sb || !jobId) return null;
  const { data, error } = await sb.from('cold_dm_scrape_jobs').select('*').eq('id', jobId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getLatestScrapeJob(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return null;
  const { data, error } = await sb
    .from('cold_dm_scrape_jobs')
    .select('id, target_username, status, scraped_count')
    .eq('client_id', clientId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function cancelScrapeJob(clientId, jobId) {
  const sb = getSupabase();
  if (!sb || !clientId) throw new Error('Supabase or clientId missing');
  if (jobId) {
    const { error } = await sb.from('cold_dm_scrape_jobs').update({ status: 'cancelled', finished_at: new Date().toISOString() }).eq('id', jobId).eq('client_id', clientId);
    if (error) throw error;
    return true;
  }
  const { data: running } = await sb
    .from('cold_dm_scrape_jobs')
    .select('id')
    .eq('client_id', clientId)
    .eq('status', 'running')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (running?.id) {
    const { error } = await sb
      .from('cold_dm_scrape_jobs')
      .update({ status: 'cancelled', finished_at: new Date().toISOString() })
      .eq('id', running.id);
    if (error) throw error;
    return true;
  }
  return false;
}

/** Returns Set of normalised usernames that have active conversations (do not scrape as leads). */
async function getConversationParticipantUsernames(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return new Set();
  try {
    const { data, error } = await sb
      .from('conversations')
      .select('participant_username')
      .eq('client_id', clientId);
    if (error) return new Set();
    const set = new Set();
    for (const row of data || []) {
      const raw = (row.participant_username || '').trim().replace(/^@/, '');
      const u = raw.toLowerCase();
      if (u) set.add(u);
    }
    return set;
  } catch (e) {
    return new Set();
  }
}

// --- Leads upsert (for scraper) ---
async function upsertLead(clientId, username, source) {
  const sb = getSupabase();
  if (!sb || !clientId) throw new Error('Supabase or clientId missing');
  const u = normalizeUsername(username);
  const { error } = await sb
    .from('cold_dm_leads')
    .upsert(
      {
        client_id: clientId,
        username: u,
        source: source || null,
        added_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,username', ignoreDuplicates: true }
    );
  if (error) throw error;
}

async function upsertLeadsBatch(clientId, usernames, source, leadGroupId = null) {
  const sb = getSupabase();
  if (!sb || !clientId) throw new Error('Supabase or clientId missing');
  const rows = usernames.map((u) => {
    const row = {
      client_id: clientId,
      username: normalizeUsername(u),
      source: source || null,
      added_at: new Date().toISOString(),
    };
    if (leadGroupId) row.lead_group_id = leadGroupId;
    return row;
  });
  if (rows.length === 0) return 0;
  const { error } = await sb
    .from('cold_dm_leads')
    .upsert(rows, {
      onConflict: 'client_id,username',
      ignoreDuplicates: !leadGroupId,
    });
  if (error) throw error;
  return rows.length;
}

// --- Campaigns ---
async function getActiveCampaigns(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return [];
  const { data, error } = await sb
    .from('cold_dm_campaigns')
    .select(
      'id, name, message_template_id, message_group_id, schedule_start_time, schedule_end_time, daily_send_limit, hourly_send_limit, min_delay_sec, max_delay_sec'
    )
    .eq('client_id', clientId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

function isWithinSchedule(scheduleStart, scheduleEnd) {
  if (!scheduleStart && !scheduleEnd) return true;
  const now = new Date();
  const current = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}`;
  const start = scheduleStart ? String(scheduleStart).slice(0, 8) : '00:00:00';
  const end = scheduleEnd ? String(scheduleEnd).slice(0, 8) : '23:59:59';
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

async function getRandomMessageFromGroup(messageGroupId) {
  const sb = getSupabase();
  if (!sb || !messageGroupId) return null;
  const { data, error } = await sb
    .from('cold_dm_message_group_messages')
    .select('message_text')
    .eq('message_group_id', messageGroupId)
    .order('sort_order', { ascending: true });
  if (error || !data || data.length === 0) return null;
  return data[Math.floor(Math.random() * data.length)].message_text;
}

async function getMessageTemplateById(templateId) {
  const sb = getSupabase();
  if (!sb || !templateId) return null;
  const { data, error } = await sb
    .from('cold_dm_message_templates')
    .select('message_text')
    .eq('id', templateId)
    .maybeSingle();
  if (error) throw error;
  return data?.message_text || null;
}

async function getNextPendingCampaignLead(clientId) {
  const sb = getSupabase();
  if (!sb || !clientId) return null;
  const campaigns = await getActiveCampaigns(clientId);
  for (const camp of campaigns) {
    if (!isWithinSchedule(camp.schedule_start_time, camp.schedule_end_time)) continue;
    let messageText = null;
    if (camp.message_group_id) {
      messageText = await getRandomMessageFromGroup(camp.message_group_id);
    }
    if (!messageText && camp.message_template_id) {
      messageText = await getMessageTemplateById(camp.message_template_id);
    }
    if (!messageText) continue;

    const { data: leadGroupRows } = await sb
      .from('cold_dm_campaign_lead_groups')
      .select('lead_group_id')
      .eq('campaign_id', camp.id);
    const leadGroupIds = (leadGroupRows || []).map((r) => r.lead_group_id).filter(Boolean);
    if (leadGroupIds.length === 0) continue;

    const { data: leadRows } = await sb
      .from('cold_dm_leads')
      .select('id, username')
      .eq('client_id', clientId)
      .in('lead_group_id', leadGroupIds);
    if (!leadRows || leadRows.length === 0) continue;

    for (const lead of leadRows) {
      const { data: existing } = await sb
        .from('cold_dm_campaign_leads')
        .select('id')
        .eq('campaign_id', camp.id)
        .eq('lead_id', lead.id)
        .maybeSingle();
      if (!existing) {
        await sb.from('cold_dm_campaign_leads').upsert(
          { campaign_id: camp.id, lead_id: lead.id, status: 'pending' },
          { onConflict: 'campaign_id,lead_id', ignoreDuplicates: true }
        );
      }
    }

    const { data: clRow, error } = await sb
      .from('cold_dm_campaign_leads')
      .select('id, lead_id')
      .eq('campaign_id', camp.id)
      .eq('status', 'pending')
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error || !clRow?.lead_id) continue;
    const { data: leadRow } = await sb
      .from('cold_dm_leads')
      .select('username')
      .eq('id', clRow.lead_id)
      .eq('client_id', clientId)
      .maybeSingle();
    if (!leadRow?.username) continue;
    return {
      campaignLeadId: clRow.id,
      campaignId: camp.id,
      leadId: clRow.lead_id,
      username: normalizeUsername(leadRow.username),
      messageText,
      messageGroupId: camp.message_group_id || null,
      dailySendLimit: camp.daily_send_limit,
      hourlySendLimit: camp.hourly_send_limit,
      minDelaySec: camp.min_delay_sec,
      maxDelaySec: camp.max_delay_sec,
    };
  }
  return null;
}

async function updateCampaignLeadStatus(campaignLeadId, status) {
  const sb = getSupabase();
  if (!sb || !campaignLeadId) throw new Error('Supabase or campaignLeadId missing');
  const { data: row } = await sb
    .from('cold_dm_campaign_leads')
    .select('campaign_id')
    .eq('id', campaignLeadId)
    .maybeSingle();
  const payload = { status };
  if (status === 'sent' || status === 'failed') payload.sent_at = new Date().toISOString();
  const { error } = await sb.from('cold_dm_campaign_leads').update(payload).eq('id', campaignLeadId);
  if (error) throw error;

  if (row && row.campaign_id && (status === 'sent' || status === 'failed')) {
    const { count } = await sb
      .from('cold_dm_campaign_leads')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', row.campaign_id)
      .eq('status', 'pending');
    if (count === 0) {
      await sb.from('cold_dm_campaigns').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', row.campaign_id);
    }
  }
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
  getSessions,
  getSessionsForCampaign,
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
  getScraperSession,
  saveScraperSession,
  getPlatformScraperSessions,
  getPlatformScraperSessionById,
  pickScraperSessionForJob,
  recordScraperActions,
  savePlatformScraperSession,
  getConversationParticipantUsernames,
  createScrapeJob,
  updateScrapeJob,
  getScrapeJob,
  getLatestScrapeJob,
  cancelScrapeJob,
  upsertLead,
  upsertLeadsBatch,
  getActiveCampaigns,
  getMessageTemplateById,
  getNextPendingCampaignLead,
  updateCampaignLeadStatus,
};
