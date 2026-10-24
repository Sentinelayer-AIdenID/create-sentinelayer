import './setup-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  delegationReferenceSchema,
  taskContextPackSchema,
  VALID_TASK_CONTEXT_PACK,
  quantitySchema,
  validateGraphIntegrity,
} from '../src/engram/contracts/index.js';

const graphWith = (predicate, object) => ({
  version: '1.0.0',
  generatedAt: '2026-10-23T12:00:00Z',
  assertions: [{
    id: 'fact-1', subject: 'order-1', predicate, object,
    provenance: 'observed', schemaValidity: 'valid',
    source: {
      sourceId: 'orders', version: '1.0.0',
      capturedAt: '2026-10-23T12:00:00Z', tenantScope: 'tenant/acme',
    },
  }],
});

test('money aliases cannot disguise binary floats as quantities', () => {
  const dollars = { kind: 'quantity', value: 1.99, unit: 'dollars' };
  assert.equal(quantitySchema.safeParse(dollars).success, false);
  assert.equal(validateGraphIntegrity(graphWith('saleValue', dollars)).valid, false);
  const count = { kind: 'quantity', value: 2, unit: 'count' };
  assert.equal(quantitySchema.safeParse(count).success, true);
  for (const predicate of ['grandTotal', 'purchase_total']) {
    assert.equal(validateGraphIntegrity(graphWith(predicate, dollars)).valid, false, predicate);
    assert.equal(validateGraphIntegrity(graphWith(predicate, count)).valid, false, predicate);
    assert.equal(validateGraphIntegrity(graphWith(predicate, {
      amount: '1.99', amountUnit: 'major_decimal', currency: 'USD', exponent: 2,
    })).valid, true, predicate);
  }
});

test('nonmoney count and temperature quantities remain valid', () => {
  assert.equal(validateGraphIntegrity(graphWith('totalCount', {
    kind: 'quantity', value: 2, unit: 'count',
  })).valid, true);
  assert.equal(validateGraphIntegrity(graphWith('temperature', {
    kind: 'quantity', value: 36.6, unit: 'celsius',
  })).valid, true);
});

test('delegation version bounds must be ordered and include the delegated version', () => {
  const base = { delegateId: 'agent/other', capability: 'graph-read@1.0.0' };
  const pack = (delegation) => taskContextPackSchema.safeParse({
    ...VALID_TASK_CONTEXT_PACK, delegations: [delegation],
  }).success;
  for (const invalid of [
    { minVersion: '9.0.0', maxVersion: '1.0.0' },
    { minVersion: '1.1.0' },
    { maxVersion: '0.9.0' },
    { minVersion: 'not-a-version' },
  ]) {
    assert.equal(delegationReferenceSchema.safeParse({ ...base, ...invalid }).success, false, JSON.stringify(invalid));
    assert.equal(pack({ ...base, ...invalid }), false, JSON.stringify(invalid));
  }
  for (const valid of [
    { minVersion: '1.0.0', maxVersion: '1.0.0' },
    { minVersion: '0.9.0', maxVersion: '1.1.0' },
  ]) {
    assert.equal(delegationReferenceSchema.safeParse({ ...base, ...valid }).success, true, JSON.stringify(valid));
    assert.equal(pack({ ...base, ...valid }), true, JSON.stringify(valid));
  }
});
