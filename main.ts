// Fusion FD1 (koordinator ronde 3) — Lane F multi-leg + Lane D plateau fix.
//
// F (+$33,46): primary edge -250bps vs 420-bar close-high (TP 105 / stop 150 /
//   tstop 150) + re-entry multi-leg max 4x (HL +80, momentum +10, pullback
//   >=50bps dari high 120 bar, peak 120 >=50 bar lalu, ret60 >= -100,
//   ddGate d <= -250 ATAU d >= -100, 100%/kaki, exit TP 85 / trail 60/25 /
//   stop 150 / tstop 180). Kelemahan F: gate `closes.length < LOOKBACK`
//   menunda entry pertama ke bar LOOKBACK -> di LB480 kaki 419 hilang,
//   net +$2,19 dan net-2x-fees -$0,996.
// D (+$26,68, (f) PENUH): diagnosis akar — (1) gate eligibility, (2) high
//   basi 69947 di window 480 bikin dip palsu 1341/1348. Fix: partial-window
//   rolling high tanpa gate + entry KONFIRMASI (pulih dari episode-low +
//   green + masih dalam) + gate peak-freshness (peak age <= 130) untuk
//   kaki dangkal. LB360 = LB480 = +$26,68 hash IDENTIK.
//
// FD1 = kerangka F (primary + re-entry multi-leg, exit F) dengan entry
// primary diganti gaya-D (konfirmasi, bukan edge) + arming episode -250
// (bukan -400, supaya episode 2 dangkal ikut ter-arm) + peak-freshness
// untuk kaki dangkal + tanpa eligibility gate. Re-entry F EXACT.
// Deterministik: tanpa clock, tanpa random, stdlib saja.
import { runBars, type BarsState } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// --- episode / lookback (gaya D) ---
const LOOKBACK = 420;
const ARM_BPS = 250; // episode arms at this drawdown vs bar-high rolling high
const DEEP_BPS = 400; // deep flag at this drawdown
const EP_END_BPS = -100; // episode ends when drawdown recovers above this
const PEAK_AGE_MAX = 130; // shallow leg: rolling high must be this fresh (bars)
// --- primary entries (gaya D, exit gaya F) ---
const RECOV_D_BPS = 30; // deep: close recovered +30bps from episode low
const RECOV_S_BPS = 10; // shallow: close recovered +10bps from episode low
const ENTRY_DEEP_BPS = -200; // shallow entry still needs this depth
const TP_BPS = 105;
const STOP_BPS = 150;
const TIME_STOP_BARS = 150;
const MAX_SLIPPAGE_BPS = 150;
const NO_ENTRY_AFTER_BAR = 1380;
// --- re-entry multi-leg (Lane F, EXACT) ---
const RE_HL_MARGIN_BPS = 80;
const RE_CONF_BPS = 10;
const RE_PB_BPS = 50;
const RE_SINCE_PK_BARS = 50;
const RE_RET60_MIN_BPS = -100;
const RE_MAX = 4;
const RE_SIZE_PCT = 100;
const RE_TP_BPS = 85;
const RE_ARM_BPS = 60;
const RE_TRAIL_BPS = 25;
const RE_STOP_BPS = 150;
const RE_TSTOP_BARS = 180;
const RE_SLIPPAGE_BPS = 100;
const HL_LOOKBACK = 30;

const closes: number[] = [];
const highs: number[] = [];
let heldSince = -1;
let peakRetBps = 0;
let leg = 0; // 0 flat, 1 primary leg, 2 re-entry leg
let armed = false;
let deep = false;
let epLow = 0;
let recovery = false;
let recLow = 0;
let epEntries = 0;
let exitsInEp = 0;
let reentries = 0;

function rollingHighCloses(lb: number): number {
  let hi = 0;
  const start = Math.max(0, closes.length - lb);
  for (let i = start; i < closes.length; i++) if (closes[i] > hi) hi = closes[i];
  return hi;
}

function rollingHighBars(lb: number): { hi: number; peakBar: number } {
  let m = -Infinity;
  let pb = -1;
  const start = highs.length > lb ? highs.length - lb : 0;
  for (let i = start; i < highs.length; i++) {
    if (highs[i] >= m) { m = highs[i]; pb = i; }
  }
  return { hi: m, peakBar: pb };
}

function rollingLow(n: number): number {
  let m = Infinity;
  const start = closes.length > n ? closes.length - n : 0;
  for (let i = start; i < closes.length; i++) if (closes[i] < m) m = closes[i];
  return m;
}

// Bars since the 120-bar high was last set (0 = set on the current bar).
function sincePeak120(): number {
  const n = Math.min(120, closes.length);
  let pk = -Infinity;
  for (let i = closes.length - n; i < closes.length; i++) if (closes[i] > pk) pk = closes[i];
  for (let i = closes.length - 1; i >= closes.length - n; i--) {
    if (closes[i] === pk) return closes.length - 1 - i;
  }
  return n;
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

    // ---- episode tracking (gaya D arming + F recovery): runs every bar.
    const { hi: hiBars, peakBar } = rollingHighBars(LOOKBACK);
    const d = ((c / hiBars) - 1) * 10000;
    if (!armed && d <= -ARM_BPS) {
      armed = true;
      deep = false;
      epLow = c;
      epEntries = 0;
      exitsInEp = 0;
      reentries = 0;
      recovery = false;
    }
    if (armed) {
      if (c < epLow) epLow = c;
      if (d <= -DEEP_BPS) deep = true;
      if (d > EP_END_BPS) {
        armed = false;
        recovery = true;
        recLow = epLow;
      }
    }
    if (recovery) {
      const dd120 = ((c / rollingHighBars(120).hi) - 1) * 10000;
      if (c < recLow * 1.002 || dd120 < -300) recovery = false;
    }

    // ---- holding: exits only, per leg (gaya F).
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
        // re-entry leg: TP / trailing / hard stop / time-stop.
        slippage = RE_SLIPPAGE_BPS;
        if (retBps >= RE_TP_BPS) exit = true;
        else if (peakRetBps >= RE_ARM_BPS && retBps <= peakRetBps - RE_TRAIL_BPS) exit = true;
        else if (retBps <= -RE_STOP_BPS) exit = true;
        else if (barsHeld >= RE_TSTOP_BARS) exit = true;
      } else {
        // primary leg: TP / hard stop / time-stop.
        if (retBps >= TP_BPS) exit = true;
        else if (retBps <= -STOP_BPS) exit = true;
        else if (barsHeld >= TIME_STOP_BARS) exit = true;
      }
      if (exit) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: slippage });
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
    if (closes.length < 2) return [];

    // Re-entry first (Lane F multi-leg, EXACT).
    const inEp = armed || recovery;
    if (inEp && exitsInEp >= 1 && reentries < RE_MAX && state.seq < NO_ENTRY_AFTER_BAR) {
      const locLow = rollingLow(HL_LOOKBACK);
      const pk120 = rollingHighBars(120).hi;
      const baseLow = armed ? epLow : recLow;
      const pullback = ((locLow / pk120) - 1) * 10000;
      const ret60 = closes.length >= 61 ? ((c / closes[closes.length - 61]) - 1) * 10000 : 0;
      const ddGate = d <= -250 || d >= -100;
      const higherLow = locLow > baseLow * (1 + RE_HL_MARGIN_BPS / 10000);
      const momentum = c >= locLow * (1 + RE_CONF_BPS / 10000);
      if (
        higherLow && momentum &&
        pullback <= -RE_PB_BPS &&
        sincePeak120() >= RE_SINCE_PK_BARS &&
        ret60 >= RE_RET60_MIN_BPS &&
        ddGate
      ) {
        let notional = (state.equity * BigInt(RE_SIZE_PCT)) / 100n;
        if (notional > state.cash) notional = state.cash;
        if (notional > 1000000n) {
          reentries += 1;
          leg = 2;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: RE_SLIPPAGE_BPS }];
        }
      }
    }

    // Primary (gaya D: konfirmasi, sekali per episode; deep dulu, baru shallow).
    if (armed && epEntries < 1 && state.seq < NO_ENTRY_AFTER_BAR) {
      const prevC = closes[closes.length - 2];
      const green = c > prevC;
      const recovD = c >= epLow * (1 + RECOV_D_BPS / 10000) && green;
      if (deep && recovD && d <= -DEEP_BPS) {
        const cash = state.cash;
        if (cash > 1000000n) {
          const room = state.weightRoom(SYMBOL);
          const spend = cash < room ? cash : room;
          if (spend > 1000000n) {
            epEntries += 1;
            leg = 1;
            return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
          }
        }
      }
      const recovS = c >= epLow * (1 + RECOV_S_BPS / 10000) && green;
      const peakAgeBars = highs.length - 1 - peakBar;
      if (recovS && d <= ENTRY_DEEP_BPS && peakAgeBars <= PEAK_AGE_MAX) {
        const cash = state.cash;
        if (cash > 1000000n) {
          const room = state.weightRoom(SYMBOL);
          const spend = cash < room ? cash : room;
          if (spend > 1000000n) {
            epEntries += 1;
            leg = 1;
            return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
          }
        }
      }
    }
    return [];
  },
});
