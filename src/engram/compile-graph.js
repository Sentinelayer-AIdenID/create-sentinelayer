/**
 * ENGRAM §EW05 — Compile source snapshots into the canonical capability graph.
 *
 * Reads a site's snapshots through the EW03 graph store and publishes ONE validated
 * generation atomically. Implements mandatory constraints:
 *
 *   • Stable tenant/source IDs; pages link to entities rather than replacing all
 *     business entities with URLs.
 *   • Resolve identifiers deterministically first; ambiguous entity links remain
 *     candidates.
 *   • Inferred claims cannot overwrite authoritative facts. Preserve validity time,
 *     locale and source precedence.
 *   • No action generated from a guessed button coordinate, guessed SKU or arbitrary
 *     executable text.
 *
 * Adds what a top professional would add:
 *   • Candidate/published generations with contradiction records.
 *   • Deterministic rebuild: same snapshots → same graph identities.
 *   • Graph cycles/bounds detection.
 *
 * Library only. Node builtins + existing EW02/EW03 contracts. No new dependency.
 */

import { createHash } from 'node:crypto';

import { graphSchema, isMoneyFieldName, isPluralMoneyFieldName, quantitySchema } from './contracts/graph.js';
import { moneySchema, currencyExponent, KNOWN_CURRENCIES, toMinorUnits } from './contracts/money.js';
import { GRAPH_SCHEMA_VERSION } from './contracts/versions.js';

// ---------------------------------------------------------------------------
// Canonical predicate vocabulary (from the EW05 proposed solution)
// ---------------------------------------------------------------------------

export const EW05_PREDICATES = Object.freeze({
  CONTAINS: 'contains',
  DESCRIBES: 'describes',
  VARIANT_OF: 'variant_of',
  HAS_MEDIA: 'has_media',
  SUPPORTED_BY: 'supported_by',
  REFERENCES: 'references',
  SAME_AS_CANDIDATE: 'same_as_candidate',
});

export const EW05_PREDICATE_SET = new Set(Object.values(EW05_PREDICATES));

// ---------------------------------------------------------------------------
// Entity kinds (deterministic, stable identifiers)
// ---------------------------------------------------------------------------

export const ENTITY_KIND = Object.freeze({
  PAGE: 'page',
  PRODUCT: 'product',
  OFFERING: 'offering',
  DOCUMENT: 'document',
  CAPABILITY: 'capability',
  MEDIA: 'media',
  ORGANISATION: 'organisation',
  UNKNOWN: 'unknown',
});

// ---------------------------------------------------------------------------
// Generation status
// ---------------------------------------------------------------------------

export const GENERATION_STATUS = Object.freeze({
  CANDIDATE: 'candidate',
  PUBLISHED: 'published',
  SUPERSEDED: 'superseded',
});

// ---------------------------------------------------------------------------
// Identity helpers — deterministic, source-normalised
// ---------------------------------------------------------------------------

const ID_SEPARATOR = ':';

/**
 * Deterministic entity id from tenant scope + kind + normalised key.
 */
function entityId(tenantScope, kind, key) {
  // Identifier-first: identity is derived from the normalised key first.
  // The kind is included in the final id only for human-readability but
  // the digest is key-only so the same name resolves to the same identity
  // regardless of how different sources classify the @type.
  const normalised = String(key ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalised) return null;
  const digest = createHash('sha256').update(`${tenantScope}|${normalised}`, 'utf-8').digest('hex').slice(0, 16);
  return `${tenantScope}${ID_SEPARATOR}${kind}${ID_SEPARATOR}${digest}`;
}

/**
 * Deterministic assertion id scoped to a source snapshot.
 */
function assertionId(sourceId, index) {
  return `${sourceId}${ID_SEPARATOR}assertion${ID_SEPARATOR}${index}`;
}

// ---------------------------------------------------------------------------
// Normalisation: canonical URL → page identity
// ---------------------------------------------------------------------------

/**
 * Normalise a URL for deterministic identity.
 */
function normaliseUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.hash = '';
  const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'gclid', 'msclkid', 'ref', 'source'];
  for (const p of trackingParams) {
    u.searchParams.delete(p);
  }
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

/**
 * Deterministic page entity id from a normalised URL.
 */
function pageEntityId(tenantScope, url) {
  const normalised = normaliseUrl(url);
  if (!normalised) return null;
  return entityId(tenantScope, ENTITY_KIND.PAGE, normalised);
}

// ---------------------------------------------------------------------------
// Fact extraction from snapshots — never guesses, always cites source
// ---------------------------------------------------------------------------

function extractEntities(tenantScope, sourceId, sourceVersion, capturedAt, facts) {
  const unresolvedFacts = [];
  const entities = [];
  if (!facts) return entities;

  for (const item of facts.jsonLd || []) {
    if (!item || typeof item !== 'object') continue;
    const type = Array.isArray(item['@type'])
      ? item['@type'][0]
      : item['@type'];
    if (!type || typeof type !== 'string') continue;

    let kind = ENTITY_KIND.UNKNOWN;
    const typeLower = type.toLowerCase();
    if (typeLower === 'product') kind = ENTITY_KIND.PRODUCT;
    else if (typeLower === 'offering' || typeLower === 'offer') kind = ENTITY_KIND.OFFERING;
    else if (typeLower === 'organization' || typeLower === 'organisation') kind = ENTITY_KIND.ORGANISATION;
    else if (typeLower === 'mediaobject' || typeLower === 'imageobject' || typeLower === 'videoobject') kind = ENTITY_KIND.MEDIA;
    else if (typeLower === 'webpage' || typeLower === 'website') continue;

    // Identifier-first resolution order
    let identityKey = null;
    let keyType = 'name';
    if (item['@id']) { identityKey = item['@id']; keyType = '@id'; }
    else if (item.sku) { identityKey = item.sku; keyType = 'sku'; }
    else if (item.gtin) { identityKey = item.gtin; keyType = 'gtin'; }
    else if (item.productID) { identityKey = item.productID; keyType = 'productID'; }
    else if (item.identifier) { identityKey = item.identifier; keyType = 'identifier'; }
    else if (item.name) { identityKey = item.name; keyType = 'name'; }

    if (!identityKey) continue;

    // Name-only entities get source-scoped ids
    const idKey = keyType === 'name'
      ? `${sourceId}|${identityKey}`
      : identityKey;
    const id = entityId(tenantScope, kind, idKey);
    if (!id) continue;

    const attributes = {};
    for (const [k, v] of Object.entries(item)) {
      if (k === '@context' || k === '@type') continue;
      if (v !== undefined && v !== null) attributes[k] = v;
    }

    const normalized = Object.keys(attributes).length > 0
      ? normalizeEntityAttributes(attributes)
      : { attrs: undefined, unresolved: [] };
    if (normalized.unresolved.length > 0) {
      for (const uf of normalized.unresolved) {
        uf.entityLabel = item.name || undefined;
        uf.entityKind = kind;
      }
      unresolvedFacts.push(...normalized.unresolved);
    }
    entities.push({
      id,
      type: kind,
      label: item.name || undefined,
      attributes: normalized.attrs,
      provenance: 'observed',
      tenantScope,
      sourceId,
      sourceVersion,
      capturedAt,
    });
  }

  return { entities, unresolvedFacts };
}

// ---------------------------------------------------------------------------
// Money normalization — schema.org prices → canonical money objects
// ---------------------------------------------------------------------------

/**
 * Container keys whose children may carry money values.
 * e.g. offers.price, shippingDetails.shippingCost
 */
const MONEY_CONTAINER_KEYS = new Set([
  'offers', 'Offers',
  'shippingDetails', 'ShippingDetails',
  'priceSpecification', 'PriceSpecification',
  'aggregateOffer', 'AggregateOffer',
]);

/** Keys that declare the currency of the amounts in the same object. */
const CURRENCY_KEYS = ['priceCurrency', 'currency', 'PriceCurrency', 'Currency'];

/** The amounts of a schema.org MonetaryAmount. */
const MONETARY_AMOUNT_KEYS = new Set(['value', 'minValue', 'maxValue']);

/** schema.org prices. A price is never negative. */
const PRICE_KEYS = new Set([
  'price', 'lowPrice', 'highPrice', 'minPrice', 'maxPrice',
  'Price', 'LowPrice', 'HighPrice', 'MinPrice', 'MaxPrice',
]);

/** Amount ranges, from the low end to the high end. */
const AMOUNT_RANGES = [
  ['lowPrice', 'highPrice'], ['minPrice', 'maxPrice'],
  ['LowPrice', 'HighPrice'], ['MinPrice', 'MaxPrice'],
  ['minValue', 'maxValue'],
];

/** schema.org counts. A whole, non-negative value is an explicit count quantity. */
const COUNT_KEYS = new Set([
  'offerCount', 'reviewCount', 'ratingCount',
  'OfferCount', 'ReviewCount', 'RatingCount',
]);

const DECIMAL_AMOUNT = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isMoney = (value) => moneySchema.safeParse(value).success;

/** Canonical money or an explicit quantity: a value already typed for the graph contract. */
function isTyped(value) {
  return isMoney(value) || quantitySchema.safeParse(value).success;
}

/**
 * True when the graph contract accepts `value` under the money name `key`:
 * canonical money, or a list of it under a plural name such as prices.
 */
function isMoneyFieldValue(key, value) {
  return isMoney(value) ||
    (Array.isArray(value) && isPluralMoneyFieldName(key) && value.every(isMoney));
}

/**
 * A schema.org MonetaryAmount: typed so, or untyped with a currency and an
 * amount, e.g. shippingRate: { value: "3.49", currency: "USD" }.
 */
function isMonetaryAmount(value) {
  if (!isPlainObject(value)) return false;
  const types = [].concat(value['@type'] ?? []);
  if (types.length > 0) return types.includes('MonetaryAmount');
  return Object.hasOwn(value, 'currency') &&
    [...MONETARY_AMOUNT_KEYS].some((key) => Object.hasOwn(value, key));
}

/** A MonetaryAmount that is one amount and its currency: canonical money once typed. */
function isSingleMonetaryAmount(value) {
  return isMonetaryAmount(value) && Object.hasOwn(value, 'value') &&
    (typeof value.value === 'string' || typeof value.value === 'number') &&
    Object.keys(value).every((key) => key === '@type' || key === 'value' || key === 'currency');
}

/**
 * True when `obj[key]` is an amount: a value under a name the graph contract
 * treats as money, a MonetaryAmount { value, currency }, or a string or
 * number amount of a larger MonetaryAmount.
 */
function isAmount(obj, key, value) {
  return isMoneyFieldName(key, value) || isSingleMonetaryAmount(value) ||
    (MONETARY_AMOUNT_KEYS.has(key) && isMonetaryAmount(obj) &&
      (typeof value === 'string' || typeof value === 'number'));
}

/**
 * True when a value holds a number outside canonical money or an explicit
 * quantity, i.e. a number the graph contract rejects as untyped.
 */
function holdsBareNumber(value) {
  if (typeof value === 'number') return true;
  if (value === null || typeof value !== 'object') return false;
  if (isTyped(value)) return false;
  return Object.values(value).some(holdsBareNumber);
}

/** True when a value holds something under a money name that the graph contract rejects. */
function holdsUntypedMoney(value) {
  if (value === null || typeof value !== 'object' || isTyped(value)) return false;
  if (Array.isArray(value)) return value.some(holdsUntypedMoney);
  return Object.entries(value).some(([key, item]) =>
    (isMoneyFieldName(key, item) && !isMoneyFieldValue(key, item)) || holdsUntypedMoney(item));
}

/** True when a value holds NaN or an infinite number, which JSON cannot represent. */
function holdsNonFiniteNumber(value) {
  if (typeof value === 'number') return !Number.isFinite(value);
  return value !== null && typeof value === 'object' && Object.values(value).some(holdsNonFiniteNumber);
}

/**
 * The currency of the amounts in `obj`: its own declared ISO 4217 code, else
 * the enclosing object's. A declared code the money registry does not know
 * ("points", "HKD", "eur"), or two codes that disagree, leave the amounts
 * without a currency; an outer currency never takes their place.
 */
function currencyInScope(obj, outer) {
  const declared = CURRENCY_KEYS.filter((key) => Object.hasOwn(obj, key) && obj[key] != null)
    .map((key) => obj[key]);
  if (declared.length === 0) return outer;
  const [code] = declared;
  return declared.every((other) => other === code) && KNOWN_CURRENCIES.has(code) ? code : null;
}

/**
 * Type the amount `raw` under `key` as canonical money in `currency`.
 * Returns { value } or the reason it cannot be typed: amount_invalid when
 * `raw` is not a decimal amount (text, a date, a flag, an object, a
 * non-finite number) or is a negative price, else currency_missing.
 */
function typeAmount(key, raw, currency) {
  const amount = typeof raw === 'number' ? String(raw) : raw;
  if (typeof amount !== 'string' || !DECIMAL_AMOUNT.test(amount)) return { reason: 'amount_invalid' };
  if (PRICE_KEYS.has(key) && amount.startsWith('-')) return { reason: 'amount_invalid' };
  if (currency == null) return { reason: 'currency_missing' };
  const money = moneySchema.safeParse({
    amount, amountUnit: 'major_decimal', currency, exponent: currencyExponent(currency),
  });
  return money.success ? { value: money.data } : { reason: 'amount_invalid' };
}

/**
 * The value the graph contract accepts under the amount `key`, as { value },
 * or the reason it cannot be typed. Canonical money passes through; a
 * MonetaryAmount { value, currency } and a decimal string or number become
 * canonical money.
 */
function typeMoney(key, raw, currency) {
  if (isMoneyFieldValue(key, raw)) return { value: raw };
  if (isSingleMonetaryAmount(raw)) return typeAmount(key, raw.value, currencyInScope(raw, currency));
  return typeAmount(key, raw, currency);
}

/**
 * Walk entity attributes, typing amounts as canonical money and counts as
 * explicit quantities. Returns { attrs, unresolved } and does not mutate the
 * input. Field names decide money exactly as the graph contract does
 * (isMoneyFieldName). A value that cannot be typed honestly is left out of
 * the attributes and recorded as an unresolved fact with its attribute path,
 * e.g. offers[0].priceSpecification[1].price, so the rest of the graph still
 * publishes.
 *
 * - Amounts (price, lowPrice, minPrice, salePrice, returnShippingFeesAmount,
 *   ...; a MonetaryAmount { value, currency }; the amounts of a larger
 *   MonetaryAmount) become canonical money in the currency in scope: the
 *   object's own priceCurrency or currency, else the enclosing object's.
 *   Without a known one: currency_missing. Anything that is not a decimal
 *   amount, such as a date (priceValidUntil), a flag (valueAddedTaxIncluded)
 *   or a negative price: amount_invalid.
 * - offers, priceSpecification, shippingDetails and aggregateOffer hold
 *   objects or lists of them. A bare value there, or in such a list (where
 *   it is nulled so later items keep their paths): not_an_object.
 * - offerCount, reviewCount or ratingCount holding a whole, non-negative
 *   safe integer becomes an explicit count quantity.
 * - Any other bare number (ratingValue: 4.6): untyped_number. A list outside
 *   the money containers that holds one is recorded whole, never spliced:
 *   untyped_money when it also holds a price, else untyped_number.
 * - A range whose low end exceeds its high end publishes neither end:
 *   range_inverted.
 * - Canonical money and explicit quantities pass through unchanged.
 */
function normalizeEntityAttributes(attrs) {
  const MAX_DEPTH = 10;
  const unresolved = [];
  const record = (field, path, rawValue, reason) => unresolved.push({ field, path, rawValue, reason });
  const pathOf = (parent, key) => (parent ? `${parent}.${key}` : key);

  // A list under a money container holds objects. Any other item is recorded
  // and nulled, so later items keep their index and path.
  function walkContainerList(list, key, currency, path, depth) {
    return list.map((item, i) => {
      if (item === null) return item;
      if (isPlainObject(item)) return walk(item, currency, `${path}[${i}]`, depth + 1);
      record(key, `${path}[${i}]`, item, 'not_an_object');
      return null;
    });
  }

  function walk(obj, outerCurrency, attrPath, depth) {
    if (depth > MAX_DEPTH || isTyped(obj)) return obj;
    const currency = currencyInScope(obj, outerCurrency);
    const result = {};

    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const path = pathOf(attrPath, key);
      if (val === undefined) {
        result[key] = val;
        continue;
      }

      if (MONEY_CONTAINER_KEYS.has(key)) {
        if (val === null) result[key] = val;
        else if (isPlainObject(val)) result[key] = walk(val, currency, path, depth + 1);
        else if (Array.isArray(val)) result[key] = walkContainerList(val, key, currency, path, depth);
        else record(key, path, val, 'not_an_object');
        continue;
      }

      if (isAmount(obj, key, val)) {
        const typed = typeMoney(key, val, currency);
        if (typed.reason) record(key, path, val, typed.reason);
        else result[key] = typed.value;
        continue;
      }

      if (COUNT_KEYS.has(key) && Number.isSafeInteger(val) && val >= 0) {
        result[key] = { kind: 'quantity', value: val, unit: 'count' };
        continue;
      }

      // Any other bare number is ambiguous to the graph contract: leave it
      // out of the attributes so the rest of the graph still publishes.
      if (typeof val === 'number') {
        record(key, path, val, 'untyped_number');
        continue;
      }

      // Arrays outside the money containers are not walked: one holding a
      // bare number is recorded whole rather than spliced.
      if (Array.isArray(val) && (holdsBareNumber(val) || holdsUntypedMoney(val))) {
        record(key, path, val, holdsUntypedMoney(val) ? 'untyped_money' : 'untyped_number');
        continue;
      }

      result[key] = isPlainObject(val) ? walk(val, currency, path, depth + 1) : val;
    }

    // A range whose low end exceeds its high end publishes neither end.
    for (const [low, high] of AMOUNT_RANGES) {
      const lowMinor = toMinorUnits(result[low]);
      const highMinor = toMinorUnits(result[high]);
      if (lowMinor == null || highMinor == null || lowMinor <= highMinor ||
          result[low].currency !== result[high].currency) continue;
      for (const key of [low, high]) {
        delete result[key];
        record(key, pathOf(attrPath, key), obj[key], 'range_inverted');
      }
    }

    return result;
  }

  const normalized = walk(attrs, null, '', 0);
  // Unresolved facts are published in the JSON graph, which cannot carry NaN
  // or Infinity (JSON.parse reads 1e999 as Infinity). Such a fact keeps its
  // field, path and reason; only the unrepresentable raw value is left out.
  for (const fact of unresolved) {
    if (holdsNonFiniteNumber(fact.rawValue)) delete fact.rawValue;
  }
  return { attrs: normalized, unresolved };
}

function extractAssertions(tenantScope, sourceId, sourceVersion, capturedAt, facts, entities) {
  const assertions = [];
  if (!facts) return assertions;

  const add = (subject, predicate, object, opts = {}) => {
    const id = assertionId(sourceId, assertions.length);
    assertions.push({
      id,
      subject,
      predicate,
      object,
      provenance: opts.provenance || 'observed',
      schemaValidity: 'unvalidated',
      modelConfidence: 'unavailable',
      freshness: { asOf: capturedAt },
      source: { sourceId, version: sourceVersion, capturedAt, tenantScope },
      ...(opts.evidenceRef ? { evidenceRef: opts.evidenceRef } : {}),
    });
  };

  const canonicalStr = typeof facts.canonical === 'string' ? facts.canonical : null;
  const pageId = canonicalStr
    ? pageEntityId(tenantScope, canonicalStr)
    : pageEntityId(tenantScope, sourceId);

  if (pageId) {
    const pageExists = entities.some((e) => e.id === pageId);
    if (!pageExists) {
      entities.push({
        id: pageId,
        type: ENTITY_KIND.PAGE,
        label: facts.title || undefined,
        provenance: 'observed',
        tenantScope,
        sourceId,
        sourceVersion,
        capturedAt,
      });
    }
  }

  if (pageId) {
    for (const entity of entities) {
      if (entity.type === ENTITY_KIND.PAGE) continue;
      add(pageId, EW05_PREDICATES.DESCRIBES, { entityId: entity.id }, { provenance: 'derived' });
    }
  }

  // Entity attribute assertions: create assertions for each entity attribute
  // so that conflicting attribute values from different sources are detectable.
  for (const entity of entities) {
    if (!entity.id || !entity.attributes) continue;
    for (const [attrKey, attrVal] of Object.entries(entity.attributes)) {
      if (attrVal === undefined || attrVal === null) continue;
      const attrPredicate = `${EW05_PREDICATES.DESCRIBES}_${attrKey}`;
      // Canonical money objects pass through as-is; other values are
      // stringified, unless the graph contract would read the string as an
      // untyped price: a price specification or a list of money stays JSON.
      const text = String(attrVal).slice(0, 1000);
      const assertionObject = isMoney(attrVal) ||
        (typeof attrVal === 'object' && isMoneyFieldName(attrPredicate, text))
        ? attrVal
        : text;
      add(entity.id, attrPredicate, assertionObject, { provenance: 'observed' });
    }
  }

  for (const heading of facts.headings || []) {
    if (pageId && heading && typeof heading === 'object' && heading !== null && typeof heading.text === 'string' && heading.text) {
      // Heading level encoded in text to avoid numeric type issues
      const level = Number(heading.level);
      if (!Number.isSafeInteger(level) || level < 1 || level > 6) continue;
      const headingLevel = `h${level}`;
      add(pageId, EW05_PREDICATES.CONTAINS, {
        kind: headingLevel,
        text: heading.text,
      });
    }
  }

  for (const link of facts.links || []) {
    if (!link.href) continue;
    const targetUrl = normaliseUrl(link.href);
    if (!targetUrl) continue;
    const targetPageId = pageEntityId(tenantScope, targetUrl);
    if (targetPageId && pageId && targetPageId !== pageId) {
      add(pageId, EW05_PREDICATES.REFERENCES, {
        entityId: targetPageId,
        url: targetUrl,
        text: link.text || undefined,
      });
    }
  }

  return assertions;
}

function mergeEntities(entityLists) {
  const map = new Map();
  for (const list of entityLists) {
    for (const entity of list) {
      const existing = map.get(entity.id);
      if (!existing) {
        map.set(entity.id, { ...entity });
      } else {
        mergeTwoEntities(existing, entity);
      }
    }
  }

  // Identifier-first: entities with the same @id-based key are already
  // merged by deterministic id in the first pass. No second-pass digest
  // merge is needed — name-only matches remain separate (see §EW05 (3)).
  const idRemap = new Map();
  return { entities: [...map.values()], idRemap };
}

function mergeTwoEntities(existing, entity) {
  const existingRank = provenanceRank(existing.provenance);
  const newRank = provenanceRank(entity.provenance);

  // Merge label: keep higher-provenance label, fall back to existing
  if (!existing.label && entity.label) {
    existing.label = entity.label;
  } else if (newRank >= existingRank && entity.label) {
    existing.label = entity.label;
  }

  // If new has higher provenance, update scalar fields (type, provenance).
  // Never downgrade a known type to UNKNOWN.
  if (newRank >= existingRank) {
    if (entity.type !== ENTITY_KIND.UNKNOWN || existing.type === ENTITY_KIND.UNKNOWN) {
      existing.type = entity.type;
    }
    existing.provenance = entity.provenance;
  }

  // Per-attribute merge: merge attributes objects by key
  if (entity.attributes && Object.keys(entity.attributes).length > 0) {
    if (!existing.attributes) existing.attributes = {};
    for (const [attrKey, attrVal] of Object.entries(entity.attributes)) {
      if (attrVal === undefined || attrVal === null) continue;
      if (!(attrKey in existing.attributes)) {
        // New attribute: adopt it
        existing.attributes[attrKey] = attrVal;
      } else if (existing.attributes[attrKey] !== attrVal) {
        // Conflicting value: retain both as an array of source-attributed values
        const prev = existing.attributes[attrKey];
        if (Array.isArray(prev)) {
          if (!prev.some((v) => typeof v === 'object' && v.value === attrVal)) {
            prev.push({ value: attrVal, provenance: entity.provenance, sourceId: entity.sourceId });
          }
        } else {
          existing.attributes[attrKey] = [
            { value: prev, provenance: existing.provenance, sourceId: existing.sourceId },
            { value: attrVal, provenance: entity.provenance, sourceId: entity.sourceId },
          ];
        }
      }
    }
  }
}

function provenanceRank(p) {
  if (p === 'authoritative') return 3;
  if (p === 'derived') return 2;
  if (p === 'observed') return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

function detectContradictions(assertions) {
  // Only single-valued attribute assertions can produce contradictions.
  // Multi-valued predicates (CONTAINS, REFERENCES, DESCRIBES) are expected
  // to have multiple values and must not generate false contradictions.
  function isSingleValued(predicate) {
    // Attribute assertions: describes_name, describes_sku, etc.
    return predicate.startsWith(EW05_PREDICATES.DESCRIBES + '_');
  }

  const byKey = new Map();
  for (const a of assertions) {
    if (!isSingleValued(a.predicate)) continue;
    const key = `${a.subject}|${a.predicate}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(a);
  }

  const contradictions = [];
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const objects = group.map((a) => JSON.stringify(a.object));
    const unique = new Set(objects);
    if (unique.size > 1) {
      contradictions.push({
        key: `${group[0].subject}|${group[0].predicate}`,
        assertionIds: group.map((a) => a.id),
        sourceIds: [...new Set(group.map((a) => a.source.sourceId))],
        objects: group.map((a) => a.object),
      });
    }
  }

  return contradictions;
}

// ---------------------------------------------------------------------------
// Cycle detection in link graph
// ---------------------------------------------------------------------------

function detectLinkCycles(links) {
  const adjacency = new Map();
  for (const link of links) {
    if (!adjacency.has(link.source)) adjacency.set(link.source, []);
    adjacency.get(link.source).push(link.target);
  }

  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const cycles = [];

  function dfs(node, path) {
    color.set(node, GRAY);
    const neighbors = adjacency.get(node) || [];
    for (const next of neighbors) {
      if (color.get(next) === GRAY) {
        const cycleStart = path.indexOf(next);
        if (cycleStart !== -1) {
          cycles.push(path.slice(cycleStart).concat(next));
        }
      } else if (color.get(next) !== BLACK) {
        dfs(next, path.concat(next));
      }
    }
    color.set(node, BLACK);
  }

  for (const node of adjacency.keys()) {
    if (!color.has(node)) {
      dfs(node, [node]);
    }
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Link dedup key (internal, not stored on link object)
// ---------------------------------------------------------------------------

function linkDedupKey(source, target, predicate) {
  return `${source}|${target}|${predicate}`;
}

// ---------------------------------------------------------------------------
// Compilation — main entry point
// ---------------------------------------------------------------------------

/**
 * Extract all data from snapshots into entities, assertions, and links.
 */
async function extractFromSnapshots(snapshots, factsProvider) {
  const allEntities = [];
  const allAssertions = [];
  const allLinks = [];
  const allUnresolvedFacts = [];

  for (const snap of snapshots) {
    let facts;
    if (typeof factsProvider === 'function') {
      try {
        facts = await factsProvider(snap);
      } catch {
        facts = null;
      }
    }

    const { entities, unresolvedFacts: snapUnresolved } = extractEntities(
      snap.tenantScope, snap.sourceId, snap.version, snap.capturedAt, facts,
    );
    if (snapUnresolved && snapUnresolved.length > 0) {
      for (const uf of snapUnresolved) {
        uf.sourceId = snap.sourceId;
        uf.tenantScope = snap.tenantScope;
      }
      allUnresolvedFacts.push(...snapUnresolved);
    }
    const assertions = extractAssertions(
      snap.tenantScope, snap.sourceId, snap.version, snap.capturedAt, facts, entities,
    );

    const canonicalStr2 = facts && typeof facts.canonical === 'string' ? facts.canonical : null;
    const pageId = canonicalStr2
      ? pageEntityId(snap.tenantScope, canonicalStr2)
      : pageEntityId(snap.tenantScope, snap.sourceId);

    // DESCRIBES links: page → entity
    if (pageId) {
      for (const entity of entities) {
        if (entity.type === ENTITY_KIND.PAGE) continue;
        allLinks.push({
          source: pageId,
          target: entity.id,
          predicate: EW05_PREDICATES.DESCRIBES,
          provenance: 'derived',
          confidence: 'medium',
          tenantScope: snap.tenantScope,
          sourceId: snap.sourceId,
          sourceVersion: snap.version,
          capturedAt: snap.capturedAt,
        });
      }
    }

    // REFERENCES links: page → other page
    if (pageId) {
      for (const link of facts?.links || []) {
        if (!link.href) continue;
        const targetUrl = normaliseUrl(link.href);
        if (!targetUrl) continue;
        const targetPageId = pageEntityId(snap.tenantScope, targetUrl);
        if (targetPageId && targetPageId !== pageId) {
          // Ensure the target page entity exists (as a placeholder if not yet seen).
          // Placeholders are marked unresolved and must not carry anchor text as label.
          if (!entities.some((e) => e.id === targetPageId)) {
            entities.push({
              id: targetPageId,
              type: ENTITY_KIND.PAGE,
              provenance: 'unresolved',
              tenantScope: snap.tenantScope,
              sourceId: snap.sourceId,
              sourceVersion: snap.version,
              capturedAt: snap.capturedAt,
            });
          }
          allLinks.push({
            source: pageId,
            target: targetPageId,
            predicate: EW05_PREDICATES.REFERENCES,
            provenance: 'observed',
            confidence: 'medium',
            tenantScope: snap.tenantScope,
            sourceId: snap.sourceId,
            sourceVersion: snap.version,
            capturedAt: snap.capturedAt,
          });
        }
      }
    }

    allEntities.push(entities);
    allAssertions.push(assertions);
  }

  return { allEntities, allAssertions, allLinks, allUnresolvedFacts };
}

/**
 * Build the final graph from extracted data.
 */
function buildGraph(allEntities, allAssertions, allLinks, allUnresolvedFacts) {
  const { entities: mergedEntities, idRemap } = mergeEntities(allEntities);
  const mergedAssertions = allAssertions.flat();

  // Deduplicate links and remap targets after identifier-first merge
  const linkMap = new Map();
  for (const link of allLinks) {
    // Remap link source/target after identifier-first entity merge
    const remappedLink = { ...link };
    if (idRemap.has(link.source)) remappedLink.source = idRemap.get(link.source);
    if (idRemap.has(link.target)) remappedLink.target = idRemap.get(link.target);
    const key = linkDedupKey(remappedLink.source, remappedLink.target, remappedLink.predicate);
    if (!linkMap.has(key)) {
      linkMap.set(key, remappedLink);
    }
  }
  const mergedLinks = [...linkMap.values()];

  // same_as_candidate links: entities with matching normalized names
  // but different identity keys (name-only matches across sources)
  const byNormalizedName = new Map();
  for (const entity of mergedEntities) {
    if (entity.type === ENTITY_KIND.PAGE) continue;
    const normalized = (entity.label || '').toLowerCase().trim();
    if (!normalized) continue;
    if (!byNormalizedName.has(normalized)) {
      byNormalizedName.set(normalized, []);
    }
    byNormalizedName.get(normalized).push(entity);
  }
  for (const [, group] of byNormalizedName) {
    if (group.length < 2) continue;
    // Create same_as_candidate links between all pairs
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const key = linkDedupKey(group[i].id, group[j].id, EW05_PREDICATES.SAME_AS_CANDIDATE);
        if (!linkMap.has(key)) {
          linkMap.set(key, {
            source: group[i].id,
            target: group[j].id,
            predicate: EW05_PREDICATES.SAME_AS_CANDIDATE,
            provenance: 'derived',
            confidence: 'low',
            tenantScope: group[i].tenantScope || group[j].tenantScope,
            sourceId: group[i].sourceId,
            sourceVersion: group[i].sourceVersion,
            capturedAt: group[i].capturedAt,
          });
        }
      }
    }
  }

  // Rebuild mergedLinks after adding same_as_candidate links
  const finalLinks = [...linkMap.values()];

  const contradictions = detectContradictions(mergedAssertions);
  const cycles = detectLinkCycles(finalLinks);

  // Deterministic: use latest snapshot timestamp, not new Date()
  let generatedAt = new Date(0).toISOString();
  for (const a of mergedAssertions) {
    if (a.source?.capturedAt && a.source.capturedAt > generatedAt) {
      generatedAt = a.source.capturedAt;
    }
  }
  if (generatedAt === new Date(0).toISOString()) {
    // Fallback for assertions without timestamps
    for (const e of mergedEntities) {
      if (e.capturedAt && e.capturedAt > generatedAt) generatedAt = e.capturedAt;
    }
  }
  const graph = {
    version: GRAPH_SCHEMA_VERSION,
    entities: mergedEntities.length > 0 ? mergedEntities : undefined,
    links: finalLinks.length > 0 ? finalLinks : undefined,
    assertions: mergedAssertions,
    unresolvedFacts: allUnresolvedFacts && allUnresolvedFacts.length > 0 ? allUnresolvedFacts : undefined,
    coverage: {
      totalAssertions: mergedAssertions.length,
      byProvenance: countBy(mergedAssertions, 'provenance'),
      bySchemaValidity: countBy(mergedAssertions, 'schemaValidity'),
    },
    generatedAt,
  };

  return { graph, contradictions, cycles, mergedEntities, mergedAssertions, finalLinks, allUnresolvedFacts };
}

async function _compile({
  graphStore,
  caller,
  namespace,
  factsProvider,
  publish = false,
} = {}) {
  if (!graphStore || typeof graphStore.listSourceSnapshots !== 'function') {
    throw new CompileGraphError('graphStore with listSourceSnapshots is required');
  }
  if (!caller || typeof caller !== 'object') {
    throw new CompileGraphError('caller identity is required');
  }
  if (!namespace || typeof namespace.raw !== 'string') {
    throw new CompileGraphError('namespace is required');
  }

  const snapshots = await graphStore.listSourceSnapshots(caller, namespace);
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new CompileGraphError('no source snapshots to compile');
  }

  const { allEntities, allAssertions, allLinks, allUnresolvedFacts } = await extractFromSnapshots(snapshots, factsProvider);
  const { graph, contradictions, cycles, mergedEntities, mergedAssertions, finalLinks } =
    buildGraph(allEntities, allAssertions, allLinks, allUnresolvedFacts);

  const schemaResult = graphSchema.safeParse(graph);
  if (!schemaResult.success && publish) {
    const messages = schemaResult.error.issues.map((i) => i.path.join('.') + ': ' + i.message);
    throw new CompileGraphError('Compiled graph invalid: ' + messages.join('; '));
  }

  if (publish) {
    const published = await graphStore.publishGraph(caller, namespace, schemaResult.data);
    return {
      graph: published.graph,
      version: published.version,
      publishedAt: published.publishedAt,
      contentHash: published.contentHash,
      entities: mergedEntities,
      links: finalLinks,
      assertions: mergedAssertions,
      contradictions,
      cycles,
      unresolvedFacts: allUnresolvedFacts,
      entityCount: mergedEntities.length,
      assertionCount: mergedAssertions.length,
      linkCount: finalLinks.length,
      sourceCount: snapshots.length,
    };
  }

  return {
    status: schemaResult.success ? GENERATION_STATUS.CANDIDATE : 'invalid',
    graph: schemaResult.success ? schemaResult.data : graph,
    schemaErrors: schemaResult.success ? [] : schemaResult.error.issues,
    contradictions,
    cycles,
    unresolvedFacts: allUnresolvedFacts,
    entityCount: mergedEntities.length,
    assertionCount: mergedAssertions.length,
    linkCount: finalLinks.length,
    sourceCount: snapshots.length,
  };
}

export async function compileGraph(opts = {}) {
  return _compile({ ...opts, publish: true });
}

export async function compileCandidate(opts = {}) {
  return _compile({ ...opts, publish: false });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countBy(items, field) {
  const counts = {};
  for (const item of items) {
    const val = item[field];
    if (val !== undefined) {
      counts[val] = (counts[val] || 0) + 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class CompileGraphError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompileGraphError';
  }
}
