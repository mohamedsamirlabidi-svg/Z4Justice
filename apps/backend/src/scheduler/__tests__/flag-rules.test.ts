import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeFlag } from '../flag-rules';

const utc = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // noon UTC to avoid TZ edge cases

describe('computeFlag — payment paid dominates', () => {
  test('paid + no dueDate → green', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), null, 'paid'), 'green');
  });
  test('paid + past dueDate → green', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2020, 1, 1), 'paid'), 'green');
  });
  test('paid + future dueDate → green', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2030, 1, 1), 'paid'), 'green');
  });
});

describe('computeFlag — missing dueDate', () => {
  test('not paid + null dueDate → none', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), null, 'pending'), 'none');
  });
  test('not paid + undefined dueDate → none', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), undefined, 'not_declared'), 'none');
  });
});

describe('computeFlag — not yet due', () => {
  test('dueDate == today → none (not overdue yet)', () => {
    const today = utc(2026, 3, 15);
    assert.equal(computeFlag(today, today, 'pending'), 'none');
  });
  test('dueDate in the future → none', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2026, 3, 16), 'pending'), 'none');
  });
});

describe('computeFlag — yellow boundary (1..7 days overdue)', () => {
  test('exactly 1 day overdue → yellow', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2026, 3, 14), 'pending'), 'yellow');
  });
  test('3 days overdue → yellow', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2026, 3, 12), 'pending'), 'yellow');
  });
  test('exactly 7 days overdue → yellow (upper boundary)', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2026, 3, 8), 'pending'), 'yellow');
  });
});

describe('computeFlag — orange boundary (8..30 days overdue)', () => {
  test('exactly 8 days overdue → orange (just past 1 week)', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2026, 3, 7), 'pending'), 'orange');
  });
  test('14 days overdue → orange', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2026, 3, 1), 'pending'), 'orange');
  });
  test('exactly 30 days overdue → orange (upper boundary)', () => {
    assert.equal(computeFlag(utc(2026, 3, 31), utc(2026, 3, 1), 'pending'), 'orange');
  });
});

describe('computeFlag — red boundary (>30 days overdue)', () => {
  test('exactly 31 days overdue → red (just past 1 month)', () => {
    assert.equal(computeFlag(utc(2026, 4, 1), utc(2026, 3, 1), 'pending'), 'red');
  });
  test('60 days overdue → red', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2026, 1, 14), 'pending'), 'red');
  });
  test('one year overdue → red', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2025, 3, 15), 'pending'), 'red');
  });
});

describe('computeFlag — different times of day within same UTC day', () => {
  test('due yesterday at 23:59 UTC, now today at 00:01 UTC → yellow (1 day)', () => {
    const due = new Date(Date.UTC(2026, 2, 14, 23, 59, 0));
    const now = new Date(Date.UTC(2026, 2, 15, 0, 1, 0));
    assert.equal(computeFlag(now, due, 'pending'), 'yellow');
  });
  test('due today at 00:00 UTC, now today at 23:59 UTC → none (same UTC day)', () => {
    const due = new Date(Date.UTC(2026, 2, 15, 0, 0, 0));
    const now = new Date(Date.UTC(2026, 2, 15, 23, 59, 0));
    assert.equal(computeFlag(now, due, 'pending'), 'none');
  });
});

describe('computeFlag — paymentStatus variants', () => {
  test('pending + overdue → yellow', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2026, 3, 14), 'pending'), 'yellow');
  });
  test('not_declared + overdue → yellow', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2026, 3, 14), 'not_declared'), 'yellow');
  });
  test('unknown status + overdue → yellow (treated as not-paid)', () => {
    assert.equal(computeFlag(utc(2026, 3, 15), utc(2026, 3, 14), 'anything-else'), 'yellow');
  });
});
