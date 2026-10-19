import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dateInZone, minuteOfDay, money, parseMoneyToCents, wallTimeToIso } from '../src/lib/format.ts';

test('parseMoneyToCents reads decimals and thousands separators', () => {
  const cases: [string, number][] = [
    ['12.50', 1250], ['8', 800], ['10.5', 1050], ['1,5', 150], ['1,000', 100000],
    ['1,000.00', 100000], ['1.234,56', 123456], [' 7.05 ', 705], ['0', 0],
  ];
  for (const [input, cents] of cases) assert.equal(parseMoneyToCents(input), cents, input);
});

test('parseMoneyToCents rejects negatives and junk', () => {
  for (const input of ['', 'abc', '-5', '-0.50']) assert.equal(parseMoneyToCents(input), 0, input);
});

test('money formats two decimals with an optional symbol', () => {
  assert.equal(money(123456, 'R'), 'R1,234.56');
  assert.equal(money(5), '0.05');
});

test('wallTimeToIso follows daylight saving in the location timezone', () => {
  assert.equal(wallTimeToIso('2030-01-07', '09:00', 'America/New_York'), '2030-01-07T14:00:00.000Z');
  assert.equal(wallTimeToIso('2030-07-08', '09:00', 'America/New_York'), '2030-07-08T13:00:00.000Z');
  assert.equal(wallTimeToIso('2030-03-10', '12:00', 'America/New_York'), '2030-03-10T16:00:00.000Z');
  assert.equal(wallTimeToIso('2030-01-07', '09:00', 'Africa/Johannesburg'), '2030-01-07T07:00:00.000Z');
});

test('dateInZone and minuteOfDay use the location day, not the browser day', () => {
  assert.equal(dateInZone(new Date('2030-01-08T04:59:00Z'), 'America/New_York'), '2030-01-07');
  assert.equal(dateInZone(new Date('2030-01-08T05:01:00Z'), 'America/New_York'), '2030-01-08');
  assert.equal(minuteOfDay('2030-01-07T14:30:00Z', 'America/New_York'), 9 * 60 + 30);
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2030-02-28', 1), '2030-03-01');
  assert.equal(addDays('2030-01-01', -1), '2029-12-31');
});
