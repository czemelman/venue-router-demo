import type { FactsProvider } from "@venue/shared";

const riskCountries = { blocked: ["KP", "IR"], high: ["NG", "RU", "VE"] };
const tierLimits = { platinum: 50000, gold: 20000, standard: 5000 };

const provider: FactsProvider = {
  get: () => ({ riskCountries, tierLimits }),
  snapshot: () => ({ riskCountries, tierLimits }),
  generateInput(rng) {
    const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)];
    return {
      customerTier: pick(["platinum", "gold", "standard", "standard"]),
      amount: Math.round(Math.exp(Math.log(50) + rng() * (Math.log(80000) - Math.log(50)))),
      accountAgeDays: Math.floor(rng() * 800),
      destinationCountry: pick(["DE", "FR", "US", "GB", "NG", "RU", "VE", "KP", "IR", "ES", "DE", "US"]),
      velocity: Math.floor(rng() ** 2 * 9),
    };
  },
  describe: (o) => ({ bucket: o.decision, signature: `${o.decision}|${[...(o.reasons ?? [])].sort().join("+")}` }),
};
export default provider;
