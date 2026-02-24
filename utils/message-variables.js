/**
 * Replaces {{variable}} placeholders in message text with lead data.
 * Supported: {{username}}, {{first_name}}, {{last_name}}, {{full_name}}. {{instagram_username}} = {{username}}.
 * If first_name/last_name are missing, they are derived from username (e.g. john_doe -> John, Doe).
 */
function substituteVariables(text, lead = {}) {
  if (!text || typeof text !== 'string') return text;
  const username = (lead.username || '').trim().replace(/^@/, '') || '';
  let first = (lead.first_name || '').trim();
  let last = (lead.last_name || '').trim();
  if (!first && !last && username) {
    const parts = username.split(/[_.\s-]+/).filter(Boolean);
    first = parts[0] ? parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase() : username;
    last = parts.length > 1 ? parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ') : '';
  }
  const fullName = [first, last].filter(Boolean).join(' ') || username;

  const vars = {
    username,
    instagram_username: username,
    first_name: first,
    last_name: last,
    full_name: fullName,
  };

  return text.replace(/\{\{\s*(\w+)\s*\}\}/gi, (_, key) => vars[key.toLowerCase()] ?? `{{${key}}}`);
}

module.exports = { substituteVariables };
