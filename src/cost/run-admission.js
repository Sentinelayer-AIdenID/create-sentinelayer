import { randomUUID } from "node:crypto";

const SCALE = 1_000_000_000n;
export function parseExposureUsd(value) {
  const text = String(value ?? "");
  if (!/^(0|[1-9]\d{0,6})(\.\d{1,9})?$/.test(text)) {
    throw new Error("Model-token exposure limit must be a positive USD decimal with at most 9 decimal places.");
  }
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole) * SCALE + BigInt(fraction.padEnd(9, "0"));
  if (amount <= 0n) throw new Error("Model-token exposure limit must be positive.");
  return amount;
}
export function formatExposureUsd(amount) {
  return `${amount / SCALE}.${String(amount % SCALE).padStart(9, "0")}`;
}

/** One process/run only. Every monetary transition is synchronous. */
export class RunAdmission {
  #maximum; #spent = 0n; #holds = new Map(); #waiters = []; #blocked = null;
  #attempts = [];
  #violated = false;
  #refused = 0;
  constructor(maximumUsd) { this.#maximum = parseExposureUsd(maximumUsd); }
  #pending() { return [...this.#holds.values()].reduce((sum, h) => sum + h.ceiling, 0n); }
  #wake() { for (const wake of this.#waiters.splice(0)) wake(); }
  async reserve(ceiling, evidence) {
    if (typeof ceiling !== "bigint" || ceiling <= 0n) throw new Error("Invalid exposure reservation.");
    while (true) {
      if (this.#blocked) { this.#refused++; throw new Error(`model_token_exposure_blocked: ${this.#blocked}`); }
      if (this.#spent + ceiling > this.#maximum) { this.#refused++; throw new Error("model_token_exposure_exhausted"); }
      if (this.#spent + this.#pending() + ceiling <= this.#maximum) {
        const id = randomUUID();
        const hold = { ...evidence, id, ceiling, status: "reserved" };
        this.#holds.set(id, hold);
        this.#attempts.push(hold);
        return id;
      }
      // Wait only while existing holds can release capacity; block() wakes all.
      await new Promise(resolve => this.#waiters.push(resolve));
    }
  }
  sent(id) {
    const hold = this.#holds.get(id);
    if (!hold || hold.status !== "reserved") throw new Error("Invalid exposure hold.");
    if (this.#blocked) throw new Error(`model_token_exposure_blocked: ${this.#blocked}`);
    hold.status = "sent";
  }
  cancelBeforeSend(id) {
    const hold = this.#holds.get(id);
    if (!hold || hold.status !== "reserved") throw new Error("Cannot release a sent exposure hold.");
    hold.status = "not_sent";
    this.#holds.delete(id);
    this.#wake();
  }
  settle(id, actual, evidence = {}) {
    const hold = this.#holds.get(id);
    if (!hold || hold.status !== "sent" || typeof actual !== "bigint" || actual < 0n) {
      throw new Error("Invalid exposure settlement.");
    }
    if (actual > hold.ceiling) {
      this.uncertain(id, "provider_bound_violation", {
        ...evidence, observedPolicyCostUsd: formatExposureUsd(actual),
        observedExcessUsd: formatExposureUsd(actual - hold.ceiling), assuranceViolated: true,
      });
      throw new Error("provider_bound_violation");
    }
    Object.assign(hold, evidence, { status: "settled", actual });
    this.#holds.delete(id);
    this.#spent += actual;
    this.#wake();
  }
  uncertain(id, reason, evidence = {}) {
    const hold = this.#holds.get(id);
    if (hold && hold.status !== "uncertain") Object.assign(hold, evidence, { status: "uncertain", reason });
    this.#violated ||= evidence.assuranceViolated === true;
    this.block(reason);
  }
  block(reason) { this.#blocked ||= reason; this.#wake(); }
  snapshot() {
    const uncertain = this.#attempts.some(attempt => attempt.status === "uncertain");
    const count = status => this.#attempts.filter(attempt => attempt.status === status).length;
    return {
      mode: "pinned-rate-model-token-exposure", scope: "single-invocation", invoiceGuarantee: false,
      assuranceStatus: this.#violated ? "violated" : uncertain ? "uncertain" : "valid",
      assuranceValid: this.#violated ? false : uncertain ? null : true,
      requestCounts: { admitted: this.#attempts.length, attempted: count("sent") + count("settled") + count("uncertain"), reserved: count("reserved"), inFlight: count("sent"), settled: count("settled"), uncertain: count("uncertain"), notSent: count("not_sent"), refused: this.#refused },
      capUsd: formatExposureUsd(this.#maximum), settledUsd: formatExposureUsd(this.#spent),
      reservedUsd: formatExposureUsd(this.#pending()), blockedReason: this.#blocked,
      attempts: this.#attempts.map(({ ceiling, actual, ...rest }) => ({
        ...rest, ceilingUsd: formatExposureUsd(ceiling), ...(actual === undefined ? {} : { actualUsd: formatExposureUsd(actual) }),
      })),
    };
  }
}
