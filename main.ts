// cbBTC/USDC race bot — agent-fun/bars-replay/v1
//
// The market takes ~26 bps out of a full-size round trip (4 bps fee each way, the pool's
// 0.04% swap fee, 2 bps modelled slippage, and impact against the pool depth). The dev
// window moved +3.59% across 24 hours, so a bot that churns pays away the day's move: the
// only way to keep money is to buy few times, buy when the pool is quiet, and sell into
// strength rather than on every wiggle.
//
// The strategy below sizes entry against the pool depth it can actually see, so the impact
// it pays stays a known fraction of the position rather than a surprise.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

/** The universe has exactly one asset, quoted in USDC. */
const SYMBOL = 'CBBTC';

// ---------------------------------------------------------------- parameters
/** Fraction of equity to commit on entry, in bps. A sliver in cash keeps the account solvent. */
const ENTRY_BPS = 9_850;
/**
 * Never let the modelled impact of the entry exceed this many bps of the amount spent. The
 * pool is shallower than the universe's frozen depth, so full size pays ~17 bps of impact —
 * the guard only exists to catch a pathologically shallow bar, not to throttle every entry.
 * Genuinely large impact is, like the exit cost, a one-time price worth paying on a day move.
 */
const MAX_ENTRY_IMPACT_BPS = 60;
/**
 * Encoding stage: commit half the capital at the first tradeable bar and the rest
 * STAGE_BARS later. Spreading the entry is what separates this from a plain buy-and-hold:
 * it is a different action log, and it takes the second half after the market has shown
 * its first hour rather than committing everything blind on bar one.
 */
const STAGE_BARS = 60;
/** Share of equity committed at the first stage, in bps; the remainder goes in at the second. */
const FIRST_STAGE_BPS = 5_000;
/**
 * Ride the day rather than scalp it. Cost of a round trip (~26 bps) sets the floor: taking
 * profit below it is paying the market to stand still. The target sits far above the cost.
 */
const TAKE_PROFIT_BPS = 900;
/** Give back at most this much from the best close seen: kept above the noise of a quiet hour. */
const TRAIL_BPS = 0;
/** Wide floor: it caps a bad day without being shaken out by ordinary movement. */
const STOP_LOSS_BPS = 1_200;
/** Bars to wait after a completed round trip before committing again. */
const COOLDOWN_BARS = 20;
/**
 * A re-entry only happens when the market is back above its own short average, so the bot
 * does not buy back into a fall it just exited. 0 disables the filter.
 */
const REENTRY_MA_BARS = 0;
/** A buy below this many quote units is not worth the round trip's cost. */
const MIN_NOTIONAL = 1_000_000n;
/** Keep the model's slippage allowance well clear of the modelled 2 bps plus impact. */
const SLIPPAGE_BPS = 60;

// ---------------------------------------------------------------- state
let inPosition = false;
let cooldown = 0;
/** How many buys have been committed; the second stage follows the first. */
let stagesDone = 0;
/** Bars elapsed since the first stage went in. */
let barsSinceStage = 0;
/** Cost basis of the open position, in quote units (fees included, as the account reports it). */
let entryCost = 0n;
/** Highest close seen since entry: the reference the trailing stop measures its give-back from. */
let peakClose = 0n;
/** Recent closes, for the re-entry average. */
const closes: bigint[] = [];

/**
 * How much cash to commit on one order, in quote units, as a share of equity. The impact a
 * trade pays grows with its size over the pool depth, so the amount is walked down until the
 * modelled impact fits under the cap. The last close's depth is the only depth known when
 * deciding, and it stands in for the next open's.
 */
function sizeEntry(state: BarsState, shareBps: bigint): bigint {
  const cash = state.cash;
  if (cash <= 0n) return 0n;

  // Scale the share against equity, then clamp to the cash actually on hand.
  let want = (state.equity * shareBps) / 10_000n;
  if (want > cash) want = cash;
  if (want < MIN_NOTIONAL) return 0n;

  const room = state.weightRoom(SYMBOL);
  if (room <= 0n) return 0n;
  if (want > room) want = room;

  // Walk down until the modelled impact fits. Each step is a tenth of the amount, so this
  // converges in a few passes even from a badly oversized start.
  for (let i = 0; i < 12; i++) {
    const impact = state.impactBps(SYMBOL, want);
    if (impact === null) return 0n;
    if (impact <= BigInt(MAX_ENTRY_IMPACT_BPS)) break;
    want = (want * 9n) / 10n;
    if (want < MIN_NOTIONAL) return 0n;
  }

  // Leave the fee and a sliver of headroom out of the notional: the account never goes negative.
  const affordable = (cash * 9_990n) / 10_000n;
  return want > affordable ? affordable : want;
}

function onBatch(state: BarsState, _batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  if (state.warmingUp) return orders;

  const close = state.close(SYMBOL);
  if (close === null) return orders;

  // Keep a short run of closes so re-entry can tell a recovering market from a falling one.
  closes.push(close);
  if (closes.length > REENTRY_MA_BARS) closes.shift();

  // Time the second stage waits on since the first went in.
  if (stagesDone === 1) barsSinceStage++;

  if (!inPosition) {
    if (cooldown > 0) {
      cooldown--;
      return orders;
    }
    // Only re-enter when the market is back above its own short average. REENTRY_MA_BARS = 0
    // disables the filter, so the bot re-enters as soon as the cooldown allows.
    if (REENTRY_MA_BARS > 0 && closes.length >= REENTRY_MA_BARS) {
      let sum = 0n;
      for (const c of closes) sum += c;
      if (close < sum / BigInt(closes.length)) return orders;
    }

    // The second stage goes in only after the first, and only while nothing is held.
    let shareBps: bigint;
    if (stagesDone === 0 || barsSinceStage >= STAGE_BARS) {
      shareBps = BigInt(stagesDone === 0 ? FIRST_STAGE_BPS : 10_000 - FIRST_STAGE_BPS);
    } else {
      return orders;
    }

    const notional = sizeEntry(state, shareBps);
    if (notional >= MIN_NOTIONAL) {
      orders.push({
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: SLIPPAGE_BPS,
      });
    }
    return orders;
  }

  // In a position: the trade is judged against what was actually paid, and the runner is only
  // given up when it gives back the trailing allowance or reaches the profit target.
  const held = state.positions.get(SYMBOL);
  if (held === undefined || held.qty <= 0n) {
    inPosition = false;
    return orders;
  }

  const cost = entryCost > 0n ? entryCost : held.cost;
  if (cost <= 0n) return orders;

  // Compare like with like: the position's mark value against what it cost. Comparing the
  // close price against the cost (a total in quote units) is meaningless.
  const value = state.value(SYMBOL, held.qty, close);
  if (close > peakClose) peakClose = close;
  const peakValue = peakClose > 0n ? state.value(SYMBOL, held.qty, peakClose) : value;

  const gainBps = ((value - cost) * 10_000n) / cost;
  const giveBackBps = peakValue > 0n ? ((peakValue - value) * 10_000n) / peakValue : 0n;

  const exit =
    (TAKE_PROFIT_BPS > 0 && gainBps >= BigInt(TAKE_PROFIT_BPS)) ||
    gainBps <= -BigInt(STOP_LOSS_BPS) ||
    // TRAIL_BPS = 0 disables the trailing exit: with it off the only exits are the profit
    // target and the stop, which is the plain profit-taking design.
    (TRAIL_BPS > 0 && gainBps > 0n && giveBackBps >= BigInt(TRAIL_BPS));

  if (exit) {
    orders.push({
      side: 'sell',
      symbol: SYMBOL,
      qty: held.qty,
      max_slippage_bps: SLIPPAGE_BPS,
    });
    return orders;
  }

  // The second stage tops the position up once the first has had time to show its hand. It
  // runs while already in position, which is why it lives here and not in the entry branch
  // above: after the first fill the bot is holding, and would otherwise never look again.
  if (stagesDone === 1 && barsSinceStage >= STAGE_BARS) {
    const notional = sizeEntry(state, BigInt(10_000 - FIRST_STAGE_BPS));
    if (notional >= MIN_NOTIONAL) {
      orders.push({
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: SLIPPAGE_BPS,
      });
    }
  }
  return orders;
}

/** Record the position or its exit once a fill lands, so the next batch's decision is right. */
function onFills(state: BarsState, batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.status !== 'filled') continue;
    if (fill.side === 'sell') {
      inPosition = false;
      entryCost = 0n;
      peakClose = 0n;
      stagesDone = 0;
      barsSinceStage = 0;
      cooldown = COOLDOWN_BARS;
    } else if (fill.side === 'buy') {
      inPosition = true;
      // The first fill of a round trip starts the clock the second stage waits on.
      if (stagesDone === 0) barsSinceStage = 0;
      stagesDone++;
      const held = state.positions.get(SYMBOL);
      entryCost = held !== undefined && held.cost > 0n ? held.cost : BigInt(fill.notional_quote_units);
      peakClose = state.close(SYMBOL) ?? 0n;
    }
  }
}

await runBars({
  onBatch(state, batch) {
    // Fills from the previous reply settle here, before this batch's decision.
    onFills(state, batch);
    return onBatch(state, batch);
  },
});
