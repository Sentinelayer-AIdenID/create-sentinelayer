import "./setup-env.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  delegationReferenceSchema,
  taskContextPackSchema,
  VALID_TASK_CONTEXT_PACK,
  graphSchema,
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
  for (const unit of ['bucks', 'aed']) {
    const disguisedMoney = { kind: 'quantity', value: 19.99, unit };
    assert.equal(quantitySchema.safeParse(disguisedMoney).success, false, unit);
    assert.equal(validateGraphIntegrity(graphWith('totalDollars', disguisedMoney)).valid, false, unit);
  }
  assert.equal(validateGraphIntegrity(graphWith('totalDollars', count)).valid, false,
    'currency-qualified predicates require canonical money even when the quantity unit is nonmonetary');
  for (const predicate of ['totalUSD', 'priceInCAD', 'balanceJPY']) {
    assert.equal(validateGraphIntegrity(graphWith(predicate, count)).valid, false, predicate);
  }
  for (const predicate of ['pricePerUnit', 'totalTax', 'purchasePriceBeforeTax', 'saleValue']) {
    assert.equal(validateGraphIntegrity(graphWith(predicate, count)).valid, false, predicate);
  }
  for (const predicate of ['basePriceRate', 'pricePerUnits', 'totalDollarsRate']) {
    assert.equal(validateGraphIntegrity(graphWith(predicate, count)).valid, false, predicate);
  }
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
  assert.equal(validateGraphIntegrity(graphWith('metadata', {
    displayCurrency: 'USD', selectedTry: true,
  })).valid, true, 'currency labels and ISO-looking boolean keys are metadata, not amounts');
  assert.equal(validateGraphIntegrity(graphWith('taxRate', {
    kind: 'quantity', value: 0.15, unit: 'ratio',
  })).valid, true);
  for (const predicate of ['order', 'invoice', 'purchase', 'sale']) {
    assert.equal(validateGraphIntegrity(graphWith(predicate, { status: 'placed' })).valid, true, predicate);
  }
  for (const unit of ['ms', 'km', 'pixel', 'meters_per_second']) {
    assert.equal(quantitySchema.safeParse({ kind: 'quantity', value: 1, unit }).success, true, unit);
  }
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

test('graph freshness claim agrees with its generation-time age', () => {
  const graph = {
    version: '1.0.0', assertions: [], generatedAt: '2026-10-23T12:00:00Z',
    freshness: {
      asOf: '2026-10-23T11:00:00Z', staleAfterMs: 1000, isStale: false,
    },
  };
  assert.equal(graphSchema.safeParse(graph).success, false);
  assert.equal(validateGraphIntegrity(graph).valid, false);
  assert.equal(graphSchema.safeParse({
    ...graph, freshness: { ...graph.freshness, isStale: true },
  }).success, true);
  assert.equal(graphSchema.safeParse({
    ...graph, freshness: {
      asOf: '2026-10-23T11:59:59.500Z', staleAfterMs: 1000, isStale: false,
    },
  }).success, true);
  assert.equal(graphSchema.safeParse({
    ...graph, freshness: {
      asOf: '2026-10-23T11:59:59Z', staleAfterMs: 1000, isStale: true,
    },
  }).success, true);
});

test('assertion freshness claim agrees with its generation-time age', () => {
  const graph = graphWith('status', 'pending');
  graph.assertions[0].source.capturedAt = '2026-10-23T11:00:00Z';
  graph.assertions[0].freshness = {
    asOf: '2026-10-23T11:00:00Z', staleAfterMs: 1000, isStale: false,
  };
  assert.equal(graphSchema.safeParse(graph).success, false,
    'an hour-old assertion cannot claim fresh after a one-second TTL');
  assert.equal(validateGraphIntegrity(graph).valid, false);

  graph.assertions[0].freshness.isStale = true;
  assert.equal(graphSchema.safeParse(graph).success, true);

  graph.assertions[0].freshness.asOf = '2026-10-23T11:59:59.001Z';
  graph.assertions[0].freshness.isStale = false;
  assert.equal(graphSchema.safeParse(graph).success, true,
    'an assertion one millisecond inside its TTL remains fresh');

  graph.assertions[0].freshness.asOf = '2026-10-23T11:59:59.000Z';
  graph.assertions[0].freshness.isStale = true;
  assert.equal(graphSchema.safeParse(graph).success, true,
    'an assertion exactly at its TTL is stale');
});
