/**
 * Same-attempt backend fallback ledger.
 *
 * The pool owns intra-attempt resilience; the orchestrator owns cross-attempt
 * policy (orchestrator-spec §3.3). Burning through the fallback chain is still
 * *one* attempt against the retry ceiling, so this ledger is bound to a single
 * attempt id and refuses to record work under another.
 *
 * Cost from failed backends is accumulated, not discarded. Dropping it would let
 * an attempt spend real money below the controller's per-node budget line — the
 * ceiling would be enforced against an under-count. Evidence from failed
 * backends is retained for the same reason plus ADR-026: the next backend and
 * any retry must be able to see what the previous one actually did.
 */

import {
  createExecutionFailure,
  deepFreeze,
  isExecutionFailure,
  isPlainObject,
  type ExecutionFailure,
} from './contracts.ts';
import { isApprovedModelId } from '../model-routing-and-evaluation/index.ts';

/** ADR-aligned ceiling: at most three backends may be consumed within one attempt. */
export const MAX_BACKENDS_PER_ATTEMPT = 3;

export type ConsumedCost = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly amount: number | null;
  readonly currency: string | null;
};

export type BackendOutcome = 'succeeded' | 'failed';

export type BackendConsumption = {
  readonly sequence: number;
  readonly model: string;
  readonly outcome: BackendOutcome;
  readonly cost: ConsumedCost;
  readonly evidence: readonly string[];
};

export type FallbackLedgerSnapshot = {
  readonly attemptId: string;
  readonly nodeId: string;
  readonly role: string;
  readonly sealed: boolean;
  readonly consumptions: readonly BackendConsumption[];
  readonly totalCost: ConsumedCost;
};

export interface BackendFallbackLedger {
  /**
   * Record one backend's consumption. `attemptId` is passed back in so a caller
   * that has drifted onto a different attempt is rejected rather than silently
   * appending to the wrong ledger.
   */
  record(input: {
    readonly attemptId: string;
    readonly model: string;
    readonly outcome: BackendOutcome;
    readonly cost: ConsumedCost;
    readonly evidence: readonly string[];
  }): BackendConsumption | ExecutionFailure;
  /** True when another backend may still be consumed under the per-attempt limit. */
  canFallback(): boolean;
  snapshot(): FallbackLedgerSnapshot;
}

function validateCost(value: unknown): ConsumedCost | ExecutionFailure {
  if (!isPlainObject(value)) return createExecutionFailure('FALLBACK_COST_INVALID');
  const { input_tokens, output_tokens, amount, currency } = value;
  const keys = Object.keys(value);
  if (keys.length !== 4) return createExecutionFailure('FALLBACK_COST_INVALID');
  if (!Number.isInteger(input_tokens) || (input_tokens as number) < 0) {
    return createExecutionFailure('FALLBACK_COST_INVALID');
  }
  if (!Number.isInteger(output_tokens) || (output_tokens as number) < 0) {
    return createExecutionFailure('FALLBACK_COST_INVALID');
  }
  if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) {
    return createExecutionFailure('FALLBACK_COST_INVALID');
  }
  if (currency !== null && typeof currency !== 'string') {
    return createExecutionFailure('FALLBACK_COST_INVALID');
  }
  // Amount and currency must be jointly present or jointly absent. An amount with
  // no currency would otherwise be folded into a later backend's currency total
  // and reported as if it had been denominated all along.
  if ((amount === null) !== (currency === null)) {
    return createExecutionFailure('FALLBACK_COST_INVALID');
  }
  return Object.freeze({
    input_tokens: input_tokens as number,
    output_tokens: output_tokens as number,
    amount: amount as number | null,
    currency: currency as string | null,
  });
}

function sumCost(consumptions: readonly BackendConsumption[]): ConsumedCost {
  let inputTokens = 0;
  let outputTokens = 0;
  let amount: number | null = null;
  let currency: string | null = null;
  // Sticky: once two currencies have been seen, no later entry may re-establish a
  // total. Resetting would let a third backend produce a partial sum that reads
  // like the attempt's full spend.
  let mixedCurrencies = false;

  for (const consumption of consumptions) {
    inputTokens += consumption.cost.input_tokens;
    outputTokens += consumption.cost.output_tokens;
    if (consumption.cost.amount === null) continue;
    if (currency !== null && consumption.cost.currency !== currency) {
      mixedCurrencies = true;
      continue;
    }
    amount = (amount ?? 0) + consumption.cost.amount;
    currency = consumption.cost.currency;
  }

  // Mixed currencies are never summed into a misleading single figure; the
  // per-backend records remain authoritative.
  if (mixedCurrencies) {
    return Object.freeze({ input_tokens: inputTokens, output_tokens: outputTokens, amount: null, currency: null });
  }
  return Object.freeze({ input_tokens: inputTokens, output_tokens: outputTokens, amount, currency });
}

export function createBackendFallbackLedger(init: {
  readonly attemptId: string;
  readonly nodeId: string;
  readonly role: string;
  readonly maxBackends?: number;
}): BackendFallbackLedger | ExecutionFailure {
  const maxBackends = init.maxBackends ?? MAX_BACKENDS_PER_ATTEMPT;
  if (!Number.isInteger(maxBackends) || maxBackends < 1 || maxBackends > MAX_BACKENDS_PER_ATTEMPT) {
    return createExecutionFailure('FALLBACK_CHAIN_LIMIT');
  }

  const consumptions: BackendConsumption[] = [];
  let sealed = false;

  const ledger: BackendFallbackLedger = {
    record(input) {
      if (input.attemptId !== init.attemptId) {
        return createExecutionFailure('FALLBACK_ATTEMPT_MISMATCH');
      }
      if (sealed) return createExecutionFailure('FALLBACK_LEDGER_SEALED');
      if (!isApprovedModelId(input.model)) {
        return createExecutionFailure('FALLBACK_MODEL_UNAPPROVED');
      }
      if (consumptions.length >= maxBackends) {
        return createExecutionFailure('FALLBACK_CHAIN_EXHAUSTED');
      }
      const cost = validateCost(input.cost);
      if (isExecutionFailure(cost)) return cost;
      if (!Array.isArray(input.evidence) || input.evidence.some((item) => typeof item !== 'string')) {
        return createExecutionFailure('FALLBACK_COST_INVALID', 'evidence must be an array of strings');
      }

      const consumption: BackendConsumption = deepFreeze({
        sequence: consumptions.length + 1,
        model: input.model,
        outcome: input.outcome,
        cost: cost as ConsumedCost,
        evidence: [...input.evidence],
      });
      consumptions.push(consumption);
      // A successful backend ends the chain; the attempt does not keep spending.
      if (input.outcome === 'succeeded') sealed = true;
      return consumption;
    },
    canFallback() {
      return !sealed && consumptions.length < maxBackends;
    },
    snapshot() {
      return deepFreeze({
        attemptId: init.attemptId,
        nodeId: init.nodeId,
        role: init.role,
        sealed,
        consumptions: [...consumptions],
        totalCost: sumCost(consumptions),
      });
    },
  };
  return Object.freeze(ledger);
}
