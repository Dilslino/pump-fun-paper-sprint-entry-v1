// Early-momentum scalper for the pump.fun paper sprint.
//
// Idea, in one paragraph: almost every pump.fun coin dies, but the few that
// run do so in their first minutes, driven by a burst of small buys from many
// distinct wallets. So we buy only coins that prove that burst — six straight
// buys from at least four distinct wallets, price up 5–45% — with the
// smallest viable stake; we then scalp the whole position at +10%, cut every
// loser at −8%, dump anything that stalls within ~200 slots, and exit at
// once on a creator dump or a single whale sell. No pyramiding into mature
// curves, no holding and hoping: the sweep showed that letting positions run
// (half-sells, wide trailing stops, long holds) gives the gains back, while
// tight scalping banks the burst itself.
//
// Everything here is deterministic: decisions use only the batch data the
// harness delivers (slots, reserves, trade events). No clock, no environment,
// no randomness. The same input stream always produces the same orders.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

export const LAMPORTS_PER_SOL = 1_000_000_000n;

// ---------------------------------------------------------------------------
// Parameters (tuned by local sweep; see STRATEGY.md for the reasoning).
// ---------------------------------------------------------------------------
export interface SniperParams {
  /** SOL spent per entry (before fees). */
  stakeLamports: bigint;
  /** Smallest buy that still counts as a guardrail round trip (0.01 SOL + margin). */
  minBuyLamports: bigint;
  /** Entry window, counted in trades seen on the curve. */
  minTrades: number;
  maxTrades: number;
  /** Minimum share of observed trades that are buys (numerator/denominator). */
  minBuyShareNum: number;
  minBuyShareDen: number;
  /** Minimum distinct wallets buying in the observed trades. */
  minDistinctBuyers: number;
  /** Price rise vs the create price, in bps, that an entry must show. */
  minRiseBps: number;
  maxRiseBps: number;
  /** Skip curves whose real SOL reserve is already this large (too mature). */
  maxRealReserveLamports: bigint;
  /** First take-profit: at this return (bps) sell this fraction of the tokens. */
  takeProfitBps: number;
  takeProfitNum: number;
  takeProfitDen: number;
  /** Trailing stop: arms once the peak return reaches this (bps); exits when the
   *  return falls this far (bps) below the peak return. */
  trailArmBps: number;
  trailDropBps: number;
  /** Hard stop: exit everything at this return (bps, negative). */
  stopLossBps: number;
  /** Time stop: after this many slots, exit unless the return is above this (bps). */
  timeStopSlots: number;
  timeStopMinBps: number;
  /** Minimum share of observed buy-side SOL volume (bps of all observed SOL
   *  volume). 0 = off. Only bites when the trade-count buy share allows
   *  sells; volume dominance is a stricter gate than trade counts. */
  minBuySolShareBps: number;
  /** Exit a held coin when one sell trade exceeds this share (bps) of the
   *  curve's real SOL reserve at that moment. 0 = off. */
  whaleSellBps: number;
  /** Minimum SOL the creator must have bought in the observed window
   *  (lamports). 0 = off. A creator with skin in the game is a weak but
   *  cheap conviction signal. */
  minCreatorBuyLamports: bigint;
  /** Slippage tolerance on every order (bps). Wide open: a 2-slot latency move
   *  must never turn an exit into a rejection. */
  maxSlippageBps: number;
}

export const DEFAULT_PARAMS: SniperParams = {
  stakeLamports: 12_000_000n,
  minBuyLamports: 12_000_000n,
  minTrades: 6,
  maxTrades: 10,
  minBuyShareNum: 4,
  minBuyShareDen: 4,
  minDistinctBuyers: 4,
  minRiseBps: 500,
  maxRiseBps: 4500,
  maxRealReserveLamports: 10_000_000_000n,
  takeProfitBps: 1000,
  takeProfitNum: 1,
  takeProfitDen: 1,
  trailArmBps: 1000,
  trailDropBps: 600,
  stopLossBps: -800,
  timeStopSlots: 200,
  timeStopMinBps: 1000,
  minBuySolShareBps: 0,
  whaleSellBps: 2000,
  minCreatorBuyLamports: 0n,
  maxSlippageBps: 10_000,
};

// ---------------------------------------------------------------------------
// Per-coin observation state (coins we are watching for an entry).
// ---------------------------------------------------------------------------
interface Observation {
  creator: string;
  createPrice: number;
  trades: number;
  buys: number;
  buyers: Set<string>;
  creatorSold: boolean;
  /** SOL volume on each side, from TradeEvent.sol_amount. */
  buySol: bigint;
  sellSol: bigint;
  /** SOL the creator has bought in the observed window. */
  creatorBuySol: bigint;
  /** A single sell took a large bite of the real reserve (post-entry signal). */
  bigSell: boolean;
  /** True once we entered, or decided never to enter this coin. */
  decided: boolean;
}

// ---------------------------------------------------------------------------
// Per-position state (coins we hold).
// ---------------------------------------------------------------------------
interface Held {
  creator: string;
  entrySlot: number;
  peakRetBps: number;
  tookProfit: boolean;
}

function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken === 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

export function createStrategy(params: SniperParams) {
  const seen = new Map<string, Observation>();
  const held = new Map<string, Held>();
  // Mints with one of our sells still in flight (decided slot + 2 latency):
  // sending a second sell for the same tokens before the first resolves
  // would only earn an insufficient_tokens rejection, so wait it out.
  const sellBusy = new Set<string>();

  function observe(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        // Price at birth from the initial virtual reserves.
        const createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (!seen.has(e.mint)) {
          seen.set(e.mint, {
            creator: e.creator,
            createPrice,
            trades: 0,
            buys: 0,
            buyers: new Set<string>(),
            creatorSold: false,
            buySol: 0n,
            sellSol: 0n,
            creatorBuySol: 0n,
            bigSell: false,
            decided: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        let ob = seen.get(e.mint);
        if (ob === undefined) {
          // First sight through a trade (create batch missed): seed from the
          // trade's own post-trade reserves so the rise filter still has a base.
          ob = {
            creator: e.creator,
            createPrice: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
            trades: 0,
            buys: 0,
            buyers: new Set<string>(),
            creatorSold: false,
            buySol: 0n,
            sellSol: 0n,
            creatorBuySol: 0n,
            bigSell: false,
            decided: false,
          };
          seen.set(e.mint, ob);
        }
        ob.trades += 1;
        const amt = BigInt(e.sol_amount);
        if (e.is_buy) {
          ob.buys += 1;
          ob.buyers.add(e.user);
          ob.buySol += amt;
          if (e.user === ob.creator) ob.creatorBuySol += amt;
        } else {
          ob.sellSol += amt;
          if (e.user === ob.creator) ob.creatorSold = true;
          if (
            params.whaleSellBps > 0 &&
            amt * 10_000n > BigInt(params.whaleSellBps) * BigInt(e.real_quote_reserves)
          ) {
            ob.bigSell = true;
          }
        }
      } else if (e.event === 'CompleteEvent') {
        const ob = seen.get(e.mint);
        if (ob !== undefined) ob.decided = true;
      }
    }
  }

  function entryOk(state: BotState, mint: string, ob: Observation): boolean {
    if (ob.decided || ob.creatorSold) return false;
    if (ob.trades < params.minTrades || ob.trades > params.maxTrades) return false;
    if (ob.buys * params.minBuyShareDen < ob.trades * params.minBuyShareNum) return false;
    if (ob.buyers.size < params.minDistinctBuyers) return false;
    if (params.minBuySolShareBps > 0) {
      const total = ob.buySol + ob.sellSol;
      if (total === 0n) return false;
      if (ob.buySol * 10_000n < total * BigInt(params.minBuySolShareBps)) return false;
    }
    if (ob.creatorBuySol < params.minCreatorBuyLamports) return false;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return false;
    if (curve.real_quote_reserves > params.maxRealReserveLamports) return false;
    if (ob.createPrice <= 0) return false;
    const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (now <= 0) return false;
    const riseBps = Math.floor(((now - ob.createPrice) / ob.createPrice) * 10_000);
    if (riseBps < params.minRiseBps || riseBps > params.maxRiseBps) return false;
    // The buy must clear the round-trip minimum with margin.
    const cap = state.maxBuyLamports(mint);
    if (cap < params.minBuyLamports) return false;
    return true;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    observe(batch);

    // Resolve in-flight sells from this batch's fills: a sell that filled,
    // was rejected or failed frees the mint for a fresh exit decision. A
    // rejected/failed take-profit also re-arms the take-profit flag.
    for (const f of batch.fills) {
      if (f.side !== 'sell' || !f.client_id.startsWith('s')) continue;
      sellBusy.delete(f.mint);
      if (f.status !== 'filled' && f.client_id.startsWith('sp')) {
        const rec = held.get(f.mint);
        if (rec !== undefined) rec.tookProfit = false;
      }
    }

    // Drop bookkeeping for positions the harness already closed.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    const maxOrders = state.hello.caps.max_orders_per_batch;
    let orderNo = 0;
    const nextSellId = (partial: boolean): string =>
      `s${partial ? 'p' : 'e'}${state.seq}-${orderNo++}`;

    // ---- 1. Exits first: every held position is re-checked every batch. ----
    for (const [mint, holding] of state.positions) {
      if (orders.length >= maxOrders) break;
      if (sellBusy.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const tokens = holding.token_amount;
      if (tokens <= 0n) continue;

      let rec = held.get(mint);
      if (rec === undefined) {
        const ob = seen.get(mint);
        rec = {
          creator: ob !== undefined ? ob.creator : '',
          entrySlot: state.slot,
          peakRetBps: 0,
          tookProfit: false,
        };
        held.set(mint, rec);
      }

      const entryPrice = Number(holding.cost_lamports) / Number(tokens);
      const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (entryPrice <= 0 || now <= 0) continue;
      const retBps = Math.floor(((now - entryPrice) / entryPrice) * 10_000);
      if (retBps > rec.peakRetBps) rec.peakRetBps = retBps;

      // Creator dumping is an instant exit, whatever the price says. So is
      // one whale sell taking a large bite of the real reserve.
      const ob = seen.get(mint);
      const creatorDumped = ob !== undefined && (ob.creatorSold || ob.bigSell);

      const heldSlots = state.slot - rec.entrySlot;
      const stopHit = retBps <= params.stopLossBps;
      const trailHit =
        rec.peakRetBps >= params.trailArmBps &&
        retBps <= rec.peakRetBps - params.trailDropBps;
      const timeHit =
        heldSlots >= params.timeStopSlots && retBps < params.timeStopMinBps;

      if (creatorDumped || stopHit || trailHit || timeHit) {
        if (free < txFee) continue;
        orders.push({
          side: 'sell',
          client_id: nextSellId(false),
          mint,
          token_amount: tokens,
          max_slippage_bps: params.maxSlippageBps,
        });
        free -= txFee;
        sellBusy.add(mint);
        continue;
      }

      // Take profit: with the shipped parameters this sells the whole
      // position at +10% (a scalp). The fraction is a parameter so the
      // trailing stop below can guard any remainder when it is not 1/1.
      if (!rec.tookProfit && retBps >= params.takeProfitBps) {
        const half = (tokens * BigInt(params.takeProfitNum)) / BigInt(params.takeProfitDen);
        if (half > 0n && free >= txFee) {
          orders.push({
            side: 'sell',
            client_id: nextSellId(true),
            mint,
            token_amount: half,
            max_slippage_bps: params.maxSlippageBps,
          });
          free -= txFee;
          rec.tookProfit = true;
          sellBusy.add(mint);
        }
      }
    }

    // ---- 2. Entries: coins in their early-trade window that pass the filter. ----
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (slots > 0) {
      for (const [mint, ob] of seen) {
        if (orders.length >= maxOrders || slots <= 0) break;
        if (ob.decided) continue;
        if (state.positions.has(mint)) {
          ob.decided = true;
          continue;
        }
        // Never buy a coin we already have an order in flight for.
        let pendingBuy = false;
        for (const p of state.pending.values()) {
          if (p.order.side === 'buy' && p.order.mint === mint) {
            pendingBuy = true;
            break;
          }
        }
        if (pendingBuy) continue;
        if (ob.trades > params.maxTrades) {
          ob.decided = true;
          continue;
        }
        if (!entryOk(state, mint, ob)) continue;
        const cap = state.maxBuyLamports(mint);
        const amount = cap < params.stakeLamports ? cap : params.stakeLamports;
        if (amount < params.minBuyLamports) continue;
        if (free < amount + txFee) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: params.maxSlippageBps,
        });
        free -= amount + txFee;
        slots -= 1;
        ob.decided = true;
      }
    }

    return orders;
  }

  return { onBatch };
}
