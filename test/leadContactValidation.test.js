'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isReliablePersonName,
  normalizeEmailAddress,
  normalizePhoneNumber,
  sanitizeDecisionMaker
} = require('../services/leadContactValidation');

test('rejects phone numbers and contact data as person names', () => {
  for (const value of ['(480) 555-1212', '+1 480 555 1212', '4805551212', 'mark@example.com', 'https://example.com']) {
    assert.equal(isReliablePersonName(value), false, value);
    assert.equal(sanitizeDecisionMaker({decisionMakerName:value}).decisionMakerName, '');
  }
});

test('rejects company and placeholder text as person names', () => {
  for (const value of ['Acme Plumbing', 'Unknown Unknown', 'Phoenix Office', 'Contact Team']) {
    assert.equal(isReliablePersonName(value), false, value);
  }
});

test('accepts credible person names including punctuation and particles', () => {
  for (const value of ["Jessa O'Neill", 'Mary-Jane Smith', 'Ludwig van Beethoven', 'José García']) {
    assert.equal(isReliablePersonName(value), true, value);
  }
});

test('normalizes contact information before CRM writes', () => {
  assert.equal(normalizeEmailAddress(' Mark@Example.COM '), 'mark@example.com');
  assert.equal(normalizeEmailAddress('4805551212'), '');
  assert.equal(normalizeEmailAddress('bad @example.com'), '');
  assert.equal(normalizePhoneNumber('(480) 555-1212'), '+14805551212');
  assert.equal(normalizePhoneNumber('+1 480 555 1212 ext. 9'), '+14805551212');
  assert.equal(normalizePhoneNumber('not a phone'), '');
});

test('clears related person metadata when a name is rejected', () => {
  const result = sanitizeDecisionMaker({
    decisionMakerName:'(480) 555-1212',
    decisionMakerTitle:'Owner',
    linkedinPersonalUrl:'https://linkedin.com/in/not-a-person'
  });
  assert.equal(result.decisionMakerName, '');
  assert.equal(result.decisionMakerTitle, '');
  assert.equal(result.linkedinPersonalUrl, '');
  assert.match(result.linkedinMatchNotes, /Rejected unreliable/);
});
