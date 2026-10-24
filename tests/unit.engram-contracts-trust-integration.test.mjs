import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  actionReceiptSchema, evidenceAddressSchema, graphSchema,
  validateGraphIntegrity, validateNotScreenshotInferred,
} from "../src/engram/contracts/index.js";

test("a trusted receipt/evidence source binds the actual price; a valid wrong-price graph stays unverified", () => {
  // This store represents independently authenticated source data, not fields
  // submitted by the candidate graph or its receipt.
  const pinned = Object.freeze({
    sku: "sku-1", price: Object.freeze({ amount: "9.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 }),
    tenantScope: "tenant/acme", sourceId: "catalog-feed", sourceVersion: "1.0.0",
  });
  const payload = JSON.stringify(pinned);
  const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const receipt = {
    receiptId: "rec-catalog-sku-1", action: "catalog.price.read", status: "executed",
    performedAt: "2026-10-23T00:00:00Z", verifier: "trusted-catalog",
    contentHash: digest(payload), tenantScope: pinned.tenantScope,
    sourceSnapshot: {
      sourceId: pinned.sourceId, sourceType: "api", version: pinned.sourceVersion,
      capturedAt: "2026-10-23T00:00:00Z", tenantScope: pinned.tenantScope,
    },
  };
  const trustedStore = new Map([[receipt.receiptId, { receipt, payload, pinned }]]);
  const address = {
    scheme: "receipt", locator: receipt.receiptId, contentHash: receipt.contentHash,
    sourceVersion: pinned.sourceVersion, tenantScope: pinned.tenantScope,
    verifiedBy: "trusted-catalog",
  };
  const evidenceRef = {
    address: `receipt:${receipt.receiptId}`, verifier: receipt.verifier,
    verifiedAt: receipt.performedAt,
  };
  const source = {
    sourceId: pinned.sourceId, version: pinned.sourceVersion,
    capturedAt: receipt.performedAt, tenantScope: pinned.tenantScope,
  };
  const graphWithPrice = (price) => ({
    version: "1.0.0", generatedAt: receipt.performedAt,
    entities: [{ id: pinned.sku, type: "product", tenantScope: pinned.tenantScope,
      sourceId: pinned.sourceId, sourceVersion: pinned.sourceVersion }],
    assertions: [{ id: "price-1", subject: pinned.sku, predicate: "price",
      object: price, provenance: "authoritative", schemaValidity: "valid",
      evidenceRef, source }],
  });

  const verifySource = (candidate) => {
    const record = trustedStore.get(candidate.locator);
    return !!record && candidate.scheme === "receipt" &&
      actionReceiptSchema.safeParse(record.receipt).success &&
      candidate.verifiedBy === record.receipt.verifier &&
      candidate.tenantScope === record.pinned.tenantScope &&
      candidate.sourceVersion === record.pinned.sourceVersion &&
      record.receipt.sourceSnapshot.sourceId === record.pinned.sourceId &&
      record.receipt.sourceSnapshot.version === record.pinned.sourceVersion &&
      candidate.contentHash === record.receipt.contentHash &&
      record.receipt.contentHash === digest(record.payload);
  };
  const verifyEvidence = (fact, reference) => {
    const record = trustedStore.get(reference?.address?.replace(/^receipt:/, ""));
    return !!record && verifySource(address) &&
      reference.address === `receipt:${record.receipt.receiptId}` &&
      reference.verifier === record.receipt.verifier &&
      reference.verifiedAt === record.receipt.performedAt &&
      fact.source.tenantScope === record.pinned.tenantScope &&
      fact.source.sourceId === record.pinned.sourceId &&
      fact.source.version === record.pinned.sourceVersion &&
      fact.subject === record.pinned.sku && fact.predicate === "price" &&
      JSON.stringify(fact.object) === JSON.stringify(record.pinned.price);
  };

  assert.equal(actionReceiptSchema.safeParse(receipt).success, true);
  assert.equal(evidenceAddressSchema.safeParse(address).success, true);
  assert.equal(validateNotScreenshotInferred(address).valid, false);
  assert.equal(validateNotScreenshotInferred(address, { verifySource }).valid, true);
  assert.equal(validateNotScreenshotInferred({ ...address, contentHash: `sha256:${"0".repeat(64)}` }, { verifySource }).valid, false);
  assert.equal(validateNotScreenshotInferred({ ...address, locator: "rec-unrelated" }, { verifySource }).valid, false);
  assert.equal(validateNotScreenshotInferred({ ...address, tenantScope: "tenant/beta" }, { verifySource }).valid, false);
  assert.equal(validateNotScreenshotInferred({ ...address, sourceVersion: "2.0.0" }, { verifySource }).valid, false);
  assert.equal(validateNotScreenshotInferred({ ...address, verifiedBy: "self" }, { verifySource }).valid, false);

  trustedStore.set(receipt.receiptId, { receipt, payload: `${payload}tampered`, pinned });
  assert.equal(validateNotScreenshotInferred(address, { verifySource }).valid, false);
  trustedStore.set(receipt.receiptId, { receipt, payload, pinned });

  const wrongPrice = graphWithPrice({ amount: "1.99", amountUnit: "major_decimal", currency: "USD", exponent: 2 });
  assert.equal(graphSchema.safeParse(wrongPrice).success, true, "wrong price is structurally valid");
  assert.equal(validateGraphIntegrity(wrongPrice).valid, false, "caller metadata does not grant authority");
  assert.equal(validateGraphIntegrity(wrongPrice, { verifyEvidence }).valid, false);
  assert.equal(validateGraphIntegrity(graphWithPrice(pinned.price), { verifyEvidence }).valid, true);
});
