// Fusion F1 (ronde 2) — Lane 1 primary + Lane 4 re-entry module.
//
// Primary (Lane 1 X250_L420_TP120, EXACT, verified +14.48 dev):
//   buy on the edge when close falls 2.5% below the 420-bar (7h) rolling high
//   (close-based), all-in. Exit TP +1.2%, hard stop -1.5%, time-stop 90 bars.
// Re-entry (Lane 4 Mode B, EXACT, verified +2.76 over its no-re-entry control):
//   after the first exit of a deep episode (drawdown <= -400bps vs the
//   bar-high-based 420-bar rolling high), buy again at 50% of equity when the
//   30-bar low sits above the episode low + 10bps and momentum keeps recovering
//   (close up +20bps from that low), inside 240 bars of the first exit, at most
//   once per episode. Re-entry leg exits: TP +1.2%, trailing arm +0.8%
//   give-back 0.3%, hard stop -2.5%.
// Precedence when flat: re-entry first (if eligible), else the primary edge.
// The primary may still fire later in a new episode (e.g. the bar ~987 dip),
// exactly as Lane 1 does on its own. Deterministic: no clock, no randomness.
import { runBars, type BarsState } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// --- primary (Lane 1) ---
const DIP_BPS = 250;
const LOOKBACK = 420;
const TP_BPS = 120;
const STOP_BPS = 150;
const TIME_STOP_BARS = 90;
const MAX_SLIPPAGE_BPS = 150;
const NO_ENTRY_AFTER_BAR = 1380;
// --- re-entry (Lane 4) ---
const RE_TRIG_BPS = 400; // episode arms at this drawdown vs bar-high rolling high
const RE_HL_MARGIN_BPS = 10;
const RE_HL_RECOV_BPS = 20;
const RE_WINDOW = 240;
const RE_MAX = 1;
const RE_SIZE_PCT = 50;
const RE_TP_BPS = 120;
const RE_ARM_BPS = 80;
const RE_TRAIL_BPS = 30;
const RE_STOP_BPS = 250;
const RE_SLIPPAGE_BPS = 100;
const HL_LOOKBACK = 30;
const EP_END_BPS = -100; // episode ends when drawdown recovers above this

const closes: number[] = [];
const highs: number[] = [];
let prevDipped = false;
let heldSince = -1;
let peakRetBps = 0;
let leg = 0; // 0 flat, 1 primary leg, 2 re-entry leg
let armed = false;
let epLow = 0;
let exitsInEp = 0;
let firstExitBar = -1;
let reentries = 0;

function rollingHighCloses(): number {
  let hi = 0;
  const start = Math.max(0, closes.length - LOOKBACK);
  for (let i = start; i < closes.length; i++) if (closes[i] > hi) hi = closes[i];
  return hi;
}

function rollingHighBars(): number {
  let m = -Infinity;
  const start = highs.length > LOOKBACK ? highs.length - LOOKBACK : 0;
  for (let i = start; i < highs.length; i++) if (highs[i] > m) m = highs[i];
  return m;
}

function rollingLow(n: number): number {
  let m = Infinity;
  const start = closes.length > n ? closes.length - n : 0;
  for (let i = start; i < closes.length; i++) if (closes[i] < m) m = closes[i];
  return m;
}

await runBars({
  onBatch(state: BarsState) {
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const c = Number(bar.c);
    const h = Number(bar.h);
    closes.push(c);
    highs.push(h);
    if (closes.length > LOOKBACK + 2) {
      closes.splice(0, closes.length - (LOOKBACK + 2));
      highs.splice(0, highs.length - (LOOKBACK + 2));
    }
    const held = state.positions.get(SYMBOL);
    const orders = [];

    // ---- episode tracking (Lane 4): runs every bar, incl. while holding.
    const d = ((c / rollingHighBars()) - 1) * 10000;
    if (!armed && d <= -RE_TRIG_BPS) {
      armed = true;
      epLow = c;
      exitsInEp = 0;
      firstExitBar = -1;
      reentries = 0;
    }
    if (armed) {
      if (c < epLow) epLow = c;
      if (d > EP_END_BPS) {
        armed = false;
        epLow = 0;
      }
    }

    // ---- holding: exits only, per leg.
    if (held !== undefined && held.qty > 0n) {
      if (heldSince < 0) { heldSince = state.seq; peakRetBps = 0; }
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const retBps = Number(((value * 10000n) / cost) - 10000n);
      if (retBps > peakRetBps) peakRetBps = retBps;
      const barsHeld = state.seq - heldSince;
      let exit = false;
      let slippage = MAX_SLIPPAGE_BPS;
      if (leg === 2) {
        // re-entry leg: TP / trailing / hard stop (Lane 4).
        slippage = RE_SLIPPAGE_BPS;
        if (retBps >= RE_TP_BPS) exit = true;
        else if (peakRetBps >= RE_ARM_BPS && retBps <= peakRetBps - RE_TRAIL_BPS) exit = true;
        else if (retBps <= -RE_STOP_BPS) exit = true;
      } else {
        // primary leg: TP / hard stop / time-stop (Lane 1).
        if (retBps >= TP_BPS) exit = true;
        else if (retBps <= -STOP_BPS) exit = true;
        else if (barsHeld >= TIME_STOP_BARS) exit = true;
      }
      if (exit) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: slippage });
        if (firstExitBar < 0) firstExitBar = state.seq;
        exitsInEp += 1;
        heldSince = -1;
        peakRetBps = 0;
        leg = 0;
      }
      return orders;
    }

    // ---- flat: entries only.
    heldSince = -1;
    peakRetBps = 0;
    leg = 0;
    if (state.warmingUp) return [];
    if (closes.length < LOOKBACK) return [];

    // Re-entry first (Lane 4 Mode B).
    if (armed && exitsInEp >= 1 && reentries < RE_MAX && firstExitBar >= 0 && state.seq - firstExitBar <= RE_WINDOW) {
      const locLow = rollingLow(HL_LOOKBACK);
      const higherLow =
        locLow > epLow * (1 + RE_HL_MARGIN_BPS / 10000) &&
        c > closes[closes.length - 2] &&
        c >= locLow * (1 + RE_HL_RECOV_BPS / 10000);
      if (higherLow && d <= EP_END_BPS) {
        let notional = (state.equity * BigInt(RE_SIZE_PCT)) / 100n;
        if (notional > state.cash) notional = state.cash;
        if (notional > 1000000n) {
          reentries += 1;
          leg = 2;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: RE_SLIPPAGE_BPS }];
        }
      }
    }

    // Primary edge (Lane 1).
    if (state.seq >= NO_ENTRY_AFTER_BAR) return [];
    const hi = rollingHighCloses();
    const dipped = c * 10000 <= hi * (10000 - DIP_BPS);
    const edge = dipped && !prevDipped;
    prevDipped = dipped;
    if (!edge) return [];
    const cash = state.cash;
    if (cash <= 1000000n) return [];
    const room = state.weightRoom(SYMBOL);
    const spend = cash < room ? cash : room;
    if (spend <= 1000000n) return [];
    leg = 1;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
