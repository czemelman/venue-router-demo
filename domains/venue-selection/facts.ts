import type { FactsProvider } from "@venue/shared";

type VenueId = "northgate" | "atlas" | "meridian-otc" | "harbor-otc";
type Status = "up" | "degraded" | "down";

interface BaseVenue {
  id: VenueId;
  kind: "exchange" | "otc";
  pairs: string[];
  baseLiquidityUsd: number;
  baseSpreadBps: number;
  fillRate1h: number;
  latencyP95Ms: number;
  otcHoursUtc?: { start: number; end: number; weekdaysOnly: boolean };
}

const VENUES: BaseVenue[] = [
  { id: "northgate", kind: "exchange", pairs: ["BTC-USD", "ETH-USD", "USDC-USD"], baseLiquidityUsd: 1_200_000, baseSpreadBps: 8, fillRate1h: 0.97, latencyP95Ms: 120 },
  { id: "atlas", kind: "exchange", pairs: ["BTC-USD", "ETH-USD", "USDC-USD", "BTC-EUR", "ETH-EUR"], baseLiquidityUsd: 900_000, baseSpreadBps: 10, fillRate1h: 0.95, latencyP95Ms: 90 },
  { id: "meridian-otc", kind: "otc", pairs: ["BTC-USD", "ETH-USD", "USDC-USD"], baseLiquidityUsd: 40_000_000, baseSpreadBps: 20, fillRate1h: 0.99, latencyP95Ms: 900, otcHoursUtc: { start: 8, end: 18, weekdaysOnly: true } },
  { id: "harbor-otc", kind: "otc", pairs: ["BTC-USD", "ETH-USD", "USDC-USD", "USDC-EUR"], baseLiquidityUsd: 25_000_000, baseSpreadBps: 24, fillRate1h: 0.98, latencyP95Ms: 1200, otcHoursUtc: { start: 7, end: 19, weekdaysOnly: true } },
];

interface Override {
  status?: Status;
  /** Multiplier on available liquidity; 0 drains the venue. */
  liquidityFactor?: number;
}

/** Quoted spread depends on order size: exchanges widen with size, OTC desks tighten. */
function effectiveSpreadBps(v: BaseVenue, amountUsd: number, liquidityUsd: number): number {
  if (v.kind === "exchange") {
    const ratio = liquidityUsd > 0 ? Math.min(amountUsd / liquidityUsd, 4) : 4;
    return round(v.baseSpreadBps + 25 * ratio, 2);
  }
  const mult = amountUsd >= 500_000 ? 0.7 : amountUsd >= 50_000 ? 1 : 1.5;
  return round(v.baseSpreadBps * mult, 2);
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

export function createVenueFacts(opts: { jitter?: boolean } = {}): FactsProvider {
  const overrides = new Map<VenueId, Override>();
  /** Per-venue multipliers, re-rolled every 5s so metrics drift a little. */
  const jit = new Map<VenueId, { liq: number; spread: number; fill: number; lat: number }>();
  const roll = (pct: number) => 1 + (Math.random() * 2 - 1) * pct;
  const reroll = () => VENUES.forEach((v) => jit.set(v.id, { liq: roll(0.08), spread: roll(0.06), fill: roll(0.01), lat: roll(0.08) }));
  let frozen = 0;
  const timer = opts.jitter ? setInterval(() => { if (!frozen) reroll(); }, 5000) : undefined;
  (timer as { unref?: () => void } | undefined)?.unref?.(); // Node only; browsers return a number
  if (opts.jitter) reroll();

  function build(amountUsd: number) {
    return VENUES.map((v) => {
      const o = overrides.get(v.id) ?? {};
      const j = jit.get(v.id) ?? { liq: 1, spread: 1, fill: 1, lat: 1 };
      const availableLiquidityUsd = Math.round(v.baseLiquidityUsd * j.liq * (o.liquidityFactor ?? 1));
      return {
        id: v.id,
        kind: v.kind,
        status: o.status ?? "up",
        pairs: v.pairs,
        availableLiquidityUsd,
        spreadBps: round(effectiveSpreadBps(v, amountUsd, availableLiquidityUsd) * j.spread, 2),
        fillRate1h: Math.min(1, round(v.fillRate1h * j.fill, 4)),
        latencyP95Ms: Math.round(v.latencyP95Ms * j.lat),
        ...(v.otcHoursUtc ? { otcHoursUtc: v.otcHoursUtc } : {}),
      };
    });
  }

  return {
    get(input) {
      const amount = (input as { txn?: { amountUsd?: number } })?.txn?.amountUsd ?? 0;
      return { venues: build(amount) };
    },
    snapshot() {
      return { venues: build(0), overrides: Object.fromEntries(overrides) };
    },
    override(body) {
      const { venueId, status, liquidityFactor, clear } = body as { venueId: VenueId; status?: Status; liquidityFactor?: number; clear?: boolean };
      if (!VENUES.some((v) => v.id === venueId)) throw new Error(`unknown venue: ${venueId}`);
      if (clear) overrides.delete(venueId);
      else overrides.set(venueId, { ...overrides.get(venueId), ...(status && { status }), ...(liquidityFactor !== undefined && { liquidityFactor }) });
      return this.snapshot();
    },
    reset() {
      overrides.clear();
    },
    freeze() {
      frozen++;
      let released = false;
      return () => { if (!released) { released = true; frozen--; } };
    },
    async isolate(fn) {
      const savedOverrides = new Map(overrides);
      const savedJit = new Map(jit);
      overrides.clear();
      jit.clear();
      frozen++;
      try {
        return await fn();
      } finally {
        frozen--;
        overrides.clear();
        savedOverrides.forEach((v, k) => overrides.set(k, v));
        jit.clear();
        savedJit.forEach((v, k) => jit.set(k, v));
      }
    },
    generateInput(rng) {
      const pick = <T,>(items: T[], weights: number[]): T => {
        let r = rng() * weights.reduce((a, b) => a + b, 0);
        for (let i = 0; i < items.length; i++) if ((r -= weights[i]) < 0) return items[i];
        return items[items.length - 1];
      };
      const tier = pick(["platinum", "gold", "standard"] as const, [1, 3, 6]);
      const asset = pick(["BTC", "ETH", "USDC"] as const, [5, 3, 2]);
      const fiat = pick(["USD", "EUR"] as const, [9, 1]);
      // log-uniform from 1k to 12M so every size bucket shows up
      const amountUsd = Math.round(Math.exp(Math.log(1_000) + rng() * (Math.log(12_000_000) - Math.log(1_000))));
      const at = new Date(Date.UTC(2026, 9, 12) + Math.floor(rng() * 7 * 24) * 3_600_000 + Math.floor(rng() * 60) * 60_000);
      return {
        customer: { id: `cust-${Math.floor(rng() * 9000) + 1000}`, tier, importanceScore: Math.round(rng() * 100) },
        txn: { asset, fiat, amountUsd, urgency: rng() < 0.3 ? "instant" : "standard", requestedAt: at.toISOString().replace(".000", "") },
      };
    },
    describe(out) {
      const chain: string[] = out.fallbackChain ?? [];
      const bucket = chain[0] ?? "NO_ROUTE";
      return { bucket, signature: [bucket, out.strategy, [...(out.flags ?? [])].sort().join("+"), out.requiresApproval].join("|") };
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

// Jitter is off under vitest so scenario expectations stay deterministic.
export default createVenueFacts({ jitter: !(typeof process !== "undefined" && process.env?.VITEST) });
