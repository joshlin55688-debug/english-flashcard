// Acceptance contract for core.js. Run: node --test tests/
process.env.TZ = 'Asia/Taipei';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

const DAY = 86400000;
const card = (over = {}) => ({ stability: 1, difficulty: 5, due: 0, reps: 1, lapses: 0, status: 'learning', lastReview: 0, ...over });

test('localDateStr uses the local calendar day, not UTC', () => {
  assert.equal(core.localDateStr(new Date('2026-01-01T16:30:00Z')), '2026-01-02');
  assert.equal(core.localDateStr(new Date('2026-01-01T15:30:00Z')), '2026-01-01');
  assert.equal(core.localDateStr(new Date(2026, 0, 5)), '2026-01-05');
});

test('isDue excludes new cards and cards due in the future', () => {
  const now = 1000 * DAY;
  assert.equal(core.isDue(card({ status: 'new', reps: 0, due: 0 }), now), false);
  assert.equal(core.isDue(card({ due: now - 1 }), now), true);
  assert.equal(core.isDue(card({ due: now }), now), true);
  assert.equal(core.isDue(card({ due: now + 1 }), now), false);
});

test('quizRating never awards the Easy bonus', () => {
  assert.equal(core.quizRating(true), 3);
  assert.equal(core.quizRating(false), 0);
});

test('applyReview counts streak days by reviews and never mutates its input', () => {
  const start = { last: '2026-03-09', count: 4, week: { '2026-03-09': 7 } };
  const frozen = JSON.stringify(start);
  const next = core.applyReview(start, '2026-03-10');
  assert.deepEqual(next, { last: '2026-03-10', count: 5, week: { '2026-03-09': 7, '2026-03-10': 1 } });
  assert.equal(JSON.stringify(start), frozen);

  const same = core.applyReview(next, '2026-03-10');
  assert.equal(same.count, 5);
  assert.equal(same.week['2026-03-10'], 2);

  assert.equal(core.applyReview(same, '2026-03-20').count, 1);
  assert.equal(core.applyReview(undefined, '2026-03-20').count, 1);
  assert.equal(core.applyReview({ last: '2026-02-28', count: 2, week: {} }, '2026-03-01').count, 3);
  assert.equal(core.applyReview({ last: '2026-03-31', count: 2, week: {} }, '2026-04-01').count, 3);
});

test('mergeStates keeps the most recently reviewed card', () => {
  const older = card({ reps: 9, lastReview: 100 });
  const newer = card({ reps: 2, lastReview: 200 });
  assert.deepEqual(core.mergeStates({ a: older }, { a: newer }).a, newer);
  assert.deepEqual(core.mergeStates({ a: newer }, { a: older }).a, newer);
});

test('mergeStates breaks lastReview ties by reps and keeps cards from either side', () => {
  const low = card({ reps: 1, lastReview: 100 });
  const high = card({ reps: 3, lastReview: 100 });
  assert.deepEqual(core.mergeStates({ a: low }, { a: high }).a, high);
  assert.deepEqual(core.mergeStates({ a: high }, { a: low }).a, high);
  const merged = core.mergeStates({ a: low }, { b: high });
  assert.deepEqual(merged.a, low);
  assert.deepEqual(merged.b, high);
});

test('mergeStates merges streak week per day by max and takes the count of the latest day', () => {
  const local = { _streak: { last: '2026-03-10', count: 2, week: { '2026-03-09': 5, '2026-03-10': 1 } } };
  const remote = { _streak: { last: '2026-03-09', count: 8, week: { '2026-03-08': 3, '2026-03-09': 9 } } };
  assert.deepEqual(core.mergeStates(local, remote)._streak, {
    last: '2026-03-10',
    count: 2,
    week: { '2026-03-08': 3, '2026-03-09': 9, '2026-03-10': 1 },
  });
  const tie = core.mergeStates(
    { _streak: { last: '2026-03-10', count: 2, week: {} } },
    { _streak: { last: '2026-03-10', count: 6, week: {} } },
  );
  assert.equal(tie._streak.count, 6);
  assert.equal(core.mergeStates({ a: card() }, {})._streak, undefined);
});

test('mergeStates does not mutate its inputs', () => {
  const local = { a: card({ lastReview: 1 }), _streak: { last: 'x', count: 1, week: {} } };
  const remote = { a: card({ lastReview: 2 }), b: card() };
  const before = JSON.stringify([local, remote]);
  core.mergeStates(local, remote);
  assert.equal(JSON.stringify([local, remote]), before);
});

test('compactForSync drops only untouched cards', () => {
  const untouched = card({ status: 'new', reps: 0 });
  const learned = card({ reps: 2 });
  const streak = { last: 'x', count: 1, week: {} };
  assert.deepEqual(core.compactForSync({ a: untouched, b: learned, _streak: streak }), { b: learned, _streak: streak });
});

test('an undone rating survives merge and sync even though lastReview moved back', () => {
  const rated = card({ reps: 1, lastReview: 500, modifiedAt: 500 });
  const undone = card({ status: 'new', reps: 0, lastReview: 0, modifiedAt: 600 });
  assert.deepEqual(core.mergeStates({ a: undone }, { a: rated }).a, undone);
  assert.deepEqual(core.mergeStates({ a: rated }, { a: undone }).a, undone);
  assert.deepEqual(core.compactForSync({ a: undone }), { a: undone });
  const legacy = card({ reps: 4, lastReview: 700 });
  assert.deepEqual(core.mergeStates({ a: undone }, { a: legacy }).a, legacy);
});

test('fuzzInterval matches the Anki fuzz ranges', () => {
  assert.equal(core.fuzzInterval(1, 0.5), 1);
  assert.equal(core.fuzzInterval(2, 0.99), 2);
  assert.equal(core.fuzzInterval(3, 0), 2);
  assert.equal(core.fuzzInterval(3, 0.999), 4);
  assert.equal(core.fuzzInterval(30, 0), 27);
  assert.equal(core.fuzzInterval(30, 0.999), 33);
  assert.equal(core.fuzzInterval(100, 0), 93);
  assert.equal(core.fuzzInterval(100, 0.999), 107);
  for (let i = 0; i < 200; i++) {
    const v = core.fuzzInterval(10);
    assert.ok(Number.isInteger(v) && v >= 8 && v <= 12, `out of range: ${v}`);
  }
});

test('dailyCounts derives usage from card state', () => {
  const today = '2026-03-10';
  const noon = new Date(2026, 2, 10, 12).getTime();
  const yesterday = new Date(2026, 2, 9, 23).getTime();
  const state = {
    a: card({ firstSeen: today, lastReview: noon }),
    b: card({ firstSeen: '2026-03-01', lastReview: noon }),
    c: card({ lastReview: noon }),
    d: card({ firstSeen: '2026-03-01', lastReview: yesterday }),
    e: card({ status: 'new', reps: 0, lastReview: 0 }),
    _streak: { last: today, count: 1, week: {} },
  };
  assert.deepEqual(core.dailyCounts(state, today), { newCards: 1, reviews: 2 });
});

test('remaining treats 0 as unlimited and never goes negative', () => {
  assert.equal(core.remaining(20, 5), 15);
  assert.equal(core.remaining(20, 25), 0);
  assert.equal(core.remaining(0, 999), Infinity);
});

test('parseBackup accepts valid backups and rejects anything else', () => {
  const state = { a: card(), _streak: { last: 'x', count: 1, week: {} } };
  assert.deepEqual(core.parseBackup(JSON.stringify(core.makeBackup(state, 1234))), state);
  assert.equal(core.makeBackup(state, 1234).app, 'flashlearn');
  assert.equal(core.makeBackup(state, 1234).exportedAt, 1234);
  for (const bad of ['not json', 'null', '[]', '{}', '{"app":"other","state":{}}', '{"app":"flashlearn","state":[]}', '{"app":"flashlearn","state":{"a":5}}']) {
    assert.throws(() => core.parseBackup(bad), `should reject ${bad}`);
  }
});
