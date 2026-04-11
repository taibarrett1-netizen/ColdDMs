/**
 * Replaces {{variable}} placeholders in message text with lead data.
 * Lead: {{username}}, {{first_name}}, {{last_name}}, {{full_name}}; {{instagram_username}} = {{username}}.
 * Account (SkeduleMore user, from users.name): {{sender_name}}, {{sender_first_name}}.
 * First name: from display_name (first word) or lead.first_name only.
 * full_name: full display_name (all words), normalized; if no display_name, first_name + last_name.
 * Never derived from username; if no name is available, first_name/full_name are empty.
 */

/**
 * Map of fancy Unicode code points → plain ASCII equivalents.
 * Built once at module load. Covers:
 *   - Mathematical Alphanumeric Symbols (U+1D400-U+1D7FF): bold, italic, script, fraktur,
 *     double-struck, sans-serif, monospace variants of A-Z / a-z / 0-9.
 *   - Fullwidth Latin letters (U+FF21-U+FF3A, U+FF41-U+FF5A).
 *   - Small-caps phonetic extensions (ᴀ ʙ ᴄ … ᴢ).
 */
const FANCY_UNICODE_MAP = (() => {
  const m = new Map();

  // Mathematical Alphanumeric Symbols — systematic ranges of 26 letters each.
  // Most ranges are contiguous; non-existent code points within a range won't appear in real text.
  const letterRanges = [
    [0x1D400, 65], [0x1D41A, 97], // Bold caps / lower
    [0x1D434, 65], [0x1D44E, 97], // Italic caps / lower
    [0x1D468, 65], [0x1D482, 97], // Bold Italic caps / lower
    [0x1D49C, 65], [0x1D4B6, 97], // Script caps / lower  (gapped — exceptions below)
    [0x1D4D0, 65], [0x1D4EA, 97], // Bold Script caps / lower  (contiguous — 𝓐-𝓩 𝓪-𝔃)
    [0x1D504, 65], [0x1D51E, 97], // Fraktur caps / lower
    [0x1D538, 65], [0x1D552, 97], // Double-Struck caps / lower
    [0x1D56C, 65], [0x1D586, 97], // Bold Fraktur caps / lower
    [0x1D5A0, 65], [0x1D5BA, 97], // Sans-Serif caps / lower
    [0x1D5D4, 65], [0x1D5EE, 97], // Sans-Serif Bold caps / lower
    [0x1D608, 65], [0x1D622, 97], // Sans-Serif Italic caps / lower
    [0x1D63C, 65], [0x1D656, 97], // Sans-Serif Bold Italic caps / lower
    [0x1D670, 65], [0x1D68A, 97], // Monospace caps / lower
  ];
  for (const [start, base] of letterRanges) {
    for (let i = 0; i < 26; i++) m.set(start + i, String.fromCharCode(base + i));
  }

  // Mathematical digits: Bold 𝟎-𝟗 (U+1D7CE), Double-Struck 𝟘-𝟡 (U+1D7D8),
  // Sans-Serif 𝟢-𝟫 (U+1D7E2), Sans-Serif Bold 𝟬-𝟵 (U+1D7EC), Monospace 𝟶-𝟿 (U+1D7F6).
  for (const base of [0x1D7CE, 0x1D7D8, 0x1D7E2, 0x1D7EC, 0x1D7F6]) {
    for (let i = 0; i < 10; i++) m.set(base + i, String.fromCharCode(48 + i));
  }

  // Letterlike exceptions that live outside the contiguous blocks.
  for (const [cp, ch] of [
    // Script capitals: B,E,F,H,I,L,M,R
    [0x212C, 'B'], [0x2130, 'E'], [0x2131, 'F'], [0x210B, 'H'],
    [0x2110, 'I'], [0x2112, 'L'], [0x2133, 'M'], [0x211B, 'R'],
    // Script lowercase: e, g, o
    [0x212F, 'e'], [0x210A, 'g'], [0x2134, 'o'],
    // Double-Struck / Fraktur / Italic exceptions: C,H,I,N,P,Q,R,Z
    [0x2102, 'C'], [0x212D, 'C'], [0x210C, 'H'], [0x210D, 'H'],
    [0x2111, 'I'], [0x2115, 'N'], [0x2119, 'P'], [0x211A, 'Q'],
    [0x211C, 'R'], [0x211D, 'R'], [0x2124, 'Z'], [0x2128, 'Z'],
  ]) m.set(cp, ch);

  // Fullwidth Latin: Ａ(U+FF21)..Ｚ, ａ(U+FF41)..ｚ
  for (let i = 0; i < 26; i++) {
    m.set(0xFF21 + i, String.fromCharCode(65 + i));
    m.set(0xFF41 + i, String.fromCharCode(97 + i));
  }

  // Small-caps phonetic extensions (common on Instagram bios)
  for (const [cp, ch] of [
    [0x1D00, 'a'], [0x0299, 'b'], [0x1D04, 'c'], [0x1D05, 'd'], [0x1D07, 'e'],
    [0xA730, 'f'], [0x0262, 'g'], [0x029C, 'h'], [0x026A, 'i'], [0x1D0A, 'j'],
    [0x1D0B, 'k'], [0x029F, 'l'], [0x1D0D, 'm'], [0x0274, 'n'], [0x1D0F, 'o'],
    [0x1D18, 'p'], [0x0280, 'r'], [0xA731, 's'], [0x1D1B, 't'], [0x1D1C, 'u'],
    [0x1D20, 'v'], [0x1D21, 'w'], [0x028F, 'y'], [0x1D22, 'z'],
  ]) m.set(cp, ch);

  return m;
})();

/** Replace fancy Unicode letters/digits with their plain ASCII equivalents. */
function transliterateFancyUnicode(str) {
  if (!str || typeof str !== 'string') return str;
  // Fast path: skip if no characters above U+007F.
  let hasHigh = false;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) { hasHigh = true; break; }
  }
  if (!hasHigh) return str;
  return [...str].map((ch) => {
    const cp = ch.codePointAt(0);
    return FANCY_UNICODE_MAP.has(cp) ? FANCY_UNICODE_MAP.get(cp) : ch;
  }).join('');
}

function normalizeName(str) {
  if (!str || typeof str !== 'string') return '';
  let s = transliterateFancyUnicode(str).trim();
  if (!s) return '';
  s = s.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu, '');
  s = s.replace(/[^\p{L}\p{N}\s-]/gu, '');
  s = s.trim();
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Full display string (e.g. "AI Setter Test") for {{full_name}} — not just the first word. */
function normalizeFullDisplayName(str) {
  if (!str || typeof str !== 'string') return '';
  let s = transliterateFancyUnicode(str).trim();
  if (!s) return '';
  s = s.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}]/gu, '');
  s = s.replace(/[^\p{L}\p{N}\s-]/gu, '');
  s = s.trim().replace(/\s+/g, ' ');
  if (!s) return '';
  return s
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''))
    .filter(Boolean)
    .join(' ');
}

/**
 * @param {string} text - Message template with {{variable}} placeholders.
 * @param {object} lead - { username, first_name?, last_name?, display_name? }.
 * @param {{ firstNameBlocklist?: Set<string>, onFirstNameEmpty?: (reason: string) => void, senderName?: string }} [opts] - Optional. senderName = SkeduleMore account display name (users.name) for {{sender_name}} / {{sender_first_name}}.
 */
function substituteVariables(text, lead = {}, opts = {}) {
  if (!text || typeof text !== 'string') return text;
  const username = (lead.username || '').trim().replace(/^@/, '') || '';
  const templateUsesFirstName = /\{\{\s*(first_name|full_name)\s*\}\}/i.test(text);

  let first = '';
  let firstEmptyReason = null;
  let last = (lead.last_name || '').trim();
  if (lead.display_name && typeof lead.display_name === 'string') {
    const firstWord = lead.display_name.trim().split(/\s+/)[0] || '';
    first = normalizeName(firstWord);
    if (!first && firstWord) firstEmptyReason = 'display_name first word normalized to empty (e.g. emoji/symbols only)';
  }
  if (!first && (lead.first_name || '').trim()) {
    first = normalizeName((lead.first_name || '').trim());
  }
  if (!first && !firstEmptyReason) {
    firstEmptyReason = 'no display_name or first_name on lead';
  }
  if (last) last = normalizeName(last);

  if (opts.firstNameBlocklist && first && opts.firstNameBlocklist.has(first.toLowerCase())) {
    const blocked = first;
    first = '';
    firstEmptyReason = `first_name blocklisted ("${blocked}")`;
  }

  if (first === '' && templateUsesFirstName && typeof opts.onFirstNameEmpty === 'function' && firstEmptyReason) {
    opts.onFirstNameEmpty(firstEmptyReason);
  }

  let fullName = '';
  if (lead.display_name && typeof lead.display_name === 'string' && lead.display_name.trim()) {
    fullName = normalizeFullDisplayName(lead.display_name);
  }
  if (!fullName) {
    fullName = [first, last].filter(Boolean).join(' ');
  }

  const senderFull = typeof opts.senderName === 'string' ? opts.senderName.trim() : '';
  let senderFirst = '';
  if (senderFull) {
    const fw = senderFull.split(/\s+/)[0] || '';
    senderFirst = normalizeName(fw);
  }

  const vars = {
    username,
    instagram_username: username,
    first_name: first,
    last_name: last,
    full_name: fullName,
    sender_name: senderFull,
    sender_first_name: senderFirst,
  };

  let out = text.replace(/\{\{\s*(\w+)\s*\}\}/gi, (_, key) => vars[key.toLowerCase()] ?? `{{${key}}}`);
  // If a placeholder was empty (e.g. {{first_name}}), avoid "Hey !" → collapse space before punctuation to "Hey!"
  out = out.replace(/\s+([.,!?;:])/g, '$1');
  return out;
}

module.exports = { substituteVariables, normalizeName, normalizeFullDisplayName };
