import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMessage } from '../src/message.js';

test('getMessage returns the expected value', () => {
  assert.equal(getMessage(), 'world');
});
