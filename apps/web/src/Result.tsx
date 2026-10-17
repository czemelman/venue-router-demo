import { useState } from "react";

export const usd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

/** Renders a decision output. Venue-style outputs get cards; anything else gets a headline, chips and JSON. */
export function Result({ out, trace }: { out: any; trace?: Record<string, any> }) {
  const [showTrace, setShowTrace] = useState(false);
  if (!out) return null;
  const headline = out.strategy ?? out.decision;
  const chips: string[] = out.flags ?? out.reasons ?? [];
  const meta = { ruleVersion: out.ruleVersion, decisionId: out.decisionId, latencyMs: out.latencyMs };
  const rest = Object.fromEntries(Object.entries(out).filter(([k]) => !["rankedVenues", "fallbackChain", "splitPlan", "trace", "ruleVersion", "decisionId", "latencyMs"].includes(k)));

  return (
    <div className="result">
      <div className="row">
        <span className="headline">{String(headline)}</span>
        {out.requiresApproval && <span className="chip warn">approval required</span>}
        {chips.map((c) => <span key={c} className={`chip ${/NO_ROUTE|reject|BLOCKED/i.test(c) ? "bad" : "warn"}`}>{c}</span>)}
        {out.primaryReason && <span className="muted">primary: {out.primaryReason}</span>}
        <span className="muted right">{meta.ruleVersion && `rules ${meta.ruleVersion}`}{meta.latencyMs !== undefined && ` · ${meta.latencyMs} ms`}</span>
      </div>

      {out.rankedVenues && (
        <>
          <div className="muted">Fallback chain: {out.fallbackChain?.length ? out.fallbackChain.join(" → ") : "(no eligible venue)"}</div>
          <div className="cards">
            {out.rankedVenues.map((v: any, i: number) => (
              <div key={v.id} className={`card ${i === 0 ? "top" : ""}`}>
                <div className="row"><strong>#{i + 1} {v.id}</strong><span className="chip">{v.kind}</span>{v.status !== "up" && <span className="chip warn">{v.status}</span>}</div>
                <div className="score">{v.score.toFixed(3)}</div>
                <div className="bar"><div style={{ width: `${Math.max(0, Math.min(1, v.score)) * 100}%` }} /></div>
                <ul>{v.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul>
              </div>
            ))}
          </div>
        </>
      )}

      {out.splitPlan && (
        <div>
          <h4>Split plan</h4>
          <table><thead><tr><th>Venue</th><th>Amount</th><th>Share</th></tr></thead><tbody>
            {out.splitPlan.allocations.map((a: any) => <tr key={a.id}><td>{a.id}</td><td>{usd(a.amountUsd)}</td><td>{(a.share * 100).toFixed(1)}%</td></tr>)}
          </tbody></table>
          {out.splitPlan.unallocatedUsd > 0 && <p className="chip bad">Unallocated: {usd(out.splitPlan.unallocatedUsd)}</p>}
        </div>
      )}

      {!out.rankedVenues && <pre>{JSON.stringify(rest, null, 2)}</pre>}

      {trace && (
        <div>
          <button className="link" onClick={() => setShowTrace(!showTrace)}>{showTrace ? "Hide" : "Show"} trace</button>
          {showTrace && Object.values<any>(trace).sort((a, b) => a.order - b.order).map((t) => (
            <details key={t.id}><summary>{t.order}. {t.name} <span className="muted">{t.performance}</span></summary>
              <pre>{JSON.stringify({ traceData: t.traceData, output: slim(t.output) }, null, 2)}</pre></details>
          ))}
        </div>
      )}
    </div>
  );
}

// node outputs carry the whole accumulated context; drop the noisy venue facts
const slim = (o: any) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([k]) => !["venues", "eligibleVenues"].includes(k))) : o);
