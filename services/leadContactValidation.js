'use strict';

const NON_PERSON_NAME_WORDS = /\b(services?|company|companies|contractors?|electric|electrical|plumbing|hvac|heating|cooling|roofing|insulation|holdings?|group|enterprises?|solutions?|agency|partners?|associates?|office|team|staff|department|careers?|jobs?|phone|mobile|cell|fax|email|contact|unknown|unnamed|n\/?a)\b/i;
const NAME_PARTICLE = /^(?:de|del|della|di|da|dos|du|la|le|van|von|der|den|bin|al)$/i;

function normalizeComparableName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(?:inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|pllc|pc|pa|llp|lp)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEmailAddress(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254 || /\s/.test(email)) return '';
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
  if (parts[0].length > 64 || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) return '';
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(parts[0])) return '';
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(parts[1])) return '';
  return email;
}

function normalizePhoneNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withoutExtension = raw.replace(/\s*(?:ext\.?|extension|x)\s*\d+\s*$/i, '');
  const digits = withoutExtension.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return '';
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

function validEmail(value) {
  return Boolean(normalizeEmailAddress(value));
}

function validPhone(value) {
  return Boolean(normalizePhoneNumber(value));
}

function isReliablePersonName(value, companyName = '') {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 100) return false;
  if (/[0-9@/\\]|https?:|www\.|\.(?:com|net|org)\b/i.test(name)) return false;
  if (NON_PERSON_NAME_WORDS.test(name)) return false;
  const words = name.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  if (/^(?:and|or|of|for|to|the|who|what|when|where|why|how|about|with|from|in|on|by)\b/i.test(name)) return false;
  const personKey = normalizeComparableName(name);
  const companyKey = normalizeComparableName(companyName);
  if (companyKey && (companyKey === personKey || companyKey.startsWith(`${personKey} `) || personKey.startsWith(`${companyKey} `))) return false;
  return words.every((word, index) => {
    if (index > 0 && NAME_PARTICLE.test(word)) return true;
    return /^\p{Lu}[\p{L}.'’,-]*$/u.test(word);
  });
}

function sanitizeDecisionMaker(prospect = {}) {
  const name = String(prospect.decisionMakerName || '').replace(/\s+/g, ' ').trim();
  const companyName = prospect.organizationName || prospect.companyName || prospect.businessName || prospect.name || '';
  if (!name || isReliablePersonName(name, companyName)) return prospect;
  return {
    ...prospect,
    decisionMakerName: '',
    decisionMakerTitle: '',
    decisionMakerSource: '',
    linkedinPersonalUrl: '',
    linkedinMatchConfidence: 'low',
    linkedinMatchNotes: `Rejected unreliable decision-maker text: ${name}`
  };
}

module.exports = {
  isReliablePersonName,
  normalizeEmailAddress,
  normalizePhoneNumber,
  sanitizeDecisionMaker,
  validEmail,
  validPhone
};
