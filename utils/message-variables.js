/**
 * Replaces {{variable}} placeholders in message text with lead data.
 * Supported: {{username}}, {{first_name}}, {{last_name}}, {{full_name}}. {{instagram_username}} = {{username}}.
 * First name: from display_name (first word, including single-word names like "CHARLIE") or lead.first_name only.
 * Never derived from username; if no name is available, first_name/full_name are empty.
 */
function normalizeName(str) {
  if (!str || typeof str !== 'string') return '';
  let s = str.trim();
  if (!s) return '';
  s = s.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu, '');
  s = s.replace(/[^\p{L}\p{N}\s-]/gu, '');
  s = s.trim();
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * @param {string} text - Message template with {{variable}} placeholders.
 * @param {object} lead - { username, first_name?, last_name?, display_name? }.
 * @param {{ firstNameBlocklist?: Set<string> }} [opts] - Optional. If first_name (resolved) is in blocklist (lowercase), it is cleared.
 */
function substituteVariables(text, lead = {}, opts = {}) {
  if (!text || typeof text !== 'string') return text;
  const username = (lead.username || '').trim().replace(/^@/, '') || '';

  let first = '';
  let last = (lead.last_name || '').trim();
  if (lead.display_name && typeof lead.display_name === 'string') {
    const firstWord = lead.display_name.trim().split(/\s+/)[0] || '';
    first = normalizeName(firstWord);
  }
  if (!first && (lead.first_name || '').trim()) {
    first = normalizeName((lead.first_name || '').trim());
  }
  if (last) last = normalizeName(last);

  if (opts.firstNameBlocklist && first && opts.firstNameBlocklist.has(first.toLowerCase())) {
    first = '';
  }

  const fullName = [first, last].filter(Boolean).join(' ');

  const vars = {
    username,
    instagram_username: username,
    first_name: first,
    last_name: last,
    full_name: fullName,
  };

  let out = text.replace(/\{\{\s*(\w+)\s*\}\}/gi, (_, key) => vars[key.toLowerCase()] ?? `{{${key}}}`);
  // If a placeholder was empty (e.g. {{first_name}}), avoid "Hey !" → collapse space before punctuation to "Hey!"
  out = out.replace(/\s+([.,!?;:])/g, '$1');
  return out;
}

module.exports = { substituteVariables, normalizeName };
