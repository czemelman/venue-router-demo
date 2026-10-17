import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Result, usd } from "../Result";
import { useStore } from "../store";

export function Live() {
  const { domain, meta, lastInput } = useStore();
  const [facts, setFacts] = useState<any>();
  const [out, setOut] = useState<any>();
  const [prev, setPrev] = useState<any>();
  const [err, setErr] = useState<string>();
  const input = (lastInput as any) ?? meta?.scenarios?.[0]?.input;
  const activeVersion = meta?.activeVersion;
  const inputRef = useRef(input); inputRef.current = input;

  const refresh = useCallback(() => api(`/domains/${domain}/facts`).then(setFacts).catch((e) => setErr(e.message)), [domain]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, [refresh]);

  // Re-run the last decision (simulate against the active version so it is not added to the log).
  const rerun = useCallback(async () => {
    if (!inputRef.current || !activeVersion) return;
    try {
      const r = await api(`/domains/${domain}/simulate?version=${activeVersion}`, { method: "POST", body: inputRef.current });
      setOut((cur: any) => { setPrev(cur); return { ...r.result, ruleVersion: r.ruleVersion, latencyMs: r.latencyMs }; });
    } catch (e: any) { setErr(e.message); }
  }, [domain, activeVersion]);
  useEffect(() => { rerun(); }, [rerun]);

  const override = async (body: any) => {
    setErr(undefined);
    try { setFacts(await api(`/domains/${domain}/facts/override`, { method: "POST", body })); await rerun(); }
    catch (e: any) { setErr(e.message); }
  };

  if (!facts) return <div className="pad">{err ?? "Loading…"}</div>;
  if (!facts.venues) return <div className="page"><p className="muted">This domain has no venue-style live facts. Raw facts:</p><pre>{JSON.stringify(facts, null, 2)}</pre></div>;

  const overrides = facts.overrides ?? {};
  const changed = prev && out && JSON.stringify(prev.fallbackChain) !== JSON.stringify(out.fallbackChain);

  return (
    <div className="page">
      <h3>Live venues</h3>
      <p className="muted">Metrics drift every 5 seconds. Flip a venue and the last decision re-runs on the active rules.</p>
      {err && <div className="status bad">{err}</div>}
      <table className="venues">
        <thead><tr><th>Venue</th><th>Kind</th><th>Status</th><th>Liquidity</th><th>Spread</th><th>Fill 1h</th><th>p95</th><th>OTC hours (UTC)</th><th>Controls</th></tr></thead>
        <tbody>
          {facts.venues.map((v: any) => {
            const o = overrides[v.id] ?? {};
            return (
              <tr key={v.id} className={v.status === "down" ? "down" : ""}>
                <td><strong>{v.id}</strong></td><td>{v.kind}</td>
                <td><span className={`chip ${v.status === "up" ? "ok" : v.status === "down" ? "bad" : "warn"}`}>{v.status}</span></td>
                <td>{usd(v.availableLiquidityUsd)}{o.liquidityFactor !== undefined && o.liquidityFactor !== 1 && <span className="chip warn">forced</span>}</td>
                <td>{v.spreadBps} bps</td><td>{(v.fillRate1h * 100).toFixed(1)}%</td><td>{v.latencyP95Ms} ms</td>
                <td>{v.otcHoursUtc ? `${v.otcHoursUtc.start}:00–${v.otcHoursUtc.end}:00 weekdays` : "24/7"}</td>
                <td className="controls">
                  {(["up", "degraded", "down"] as const).map((s) => <button key={s} className={v.status === s ? "on" : ""} onClick={() => override({ venueId: v.id, status: s })}>{s}</button>)}
                  <button className={o.liquidityFactor === 0 ? "on" : ""} onClick={() => override({ venueId: v.id, liquidityFactor: o.liquidityFactor === 0 ? 1 : 0 })}>{o.liquidityFactor === 0 ? "restore liquidity" : "drain liquidity"}</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button onClick={() => Promise.all(facts.venues.map((v: any) => api(`/domains/${domain}/facts/override`, { method: "POST", body: { venueId: v.id, clear: true } }))).then(refresh).then(rerun)}>Reset all overrides</button>

      <h3>Last decision, re-run live {changed && <span className="chip warn">routing changed</span>}</h3>
      <pre className="input">{JSON.stringify(input)}</pre>
      <Result out={out} />
    </div>
  );
}
