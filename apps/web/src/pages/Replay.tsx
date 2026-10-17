import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

export function Replay() {
  const { domain, meta } = useStore();
  const [versions, setVersions] = useState<string[]>([]);
  const [a, setA] = useState("draft");
  const [b, setB] = useState("");
  const [n, setN] = useState(1000);
  const [source, setSource] = useState("synthetic");
  const [res, setRes] = useState<any>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRes(undefined);
    api(`/domains/${domain}/rules/versions`).then((v) => { setVersions(v.versions.map((x: any) => x.version)); setB(v.active); }).catch((e) => setErr(e.message));
  }, [domain, meta?.activeVersion]);

  const run = async () => {
    setBusy(true); setErr(undefined);
    try { setRes(await api(`/domains/${domain}/replay`, { method: "POST", body: { n, a, b, source } })); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const opts = ["draft", ...versions];
  const buckets = res ? Object.entries<any>(res.distribution).sort((x, y) => y[1].a + y[1].b - (x[1].a + x[1].b)) : [];

  return (
    <div className="page">
      <h3>Replay</h3>
      <p className="muted">Run many inputs through two rule versions and see how decisions shift. Uses current live facts, held steady for the run. Save your draft on the Rules page first.</p>
      <div className="toolbar plain">
        <label className="inline">A <select value={a} onChange={(e) => setA(e.target.value)}>{opts.map((o) => <option key={o}>{o}</option>)}</select></label>
        <span>vs</span>
        <label className="inline">B <select value={b} onChange={(e) => setB(e.target.value)}>{opts.map((o) => <option key={o}>{o}</option>)}</select></label>
        <label className="inline">Inputs <input type="number" value={n} min={1} max={5000} style={{ width: 90 }} onChange={(e) => setN(Number(e.target.value))} /></label>
        <label className="inline">Source <select value={source} onChange={(e) => setSource(e.target.value)}><option value="synthetic">synthetic</option><option value="log">decision log</option></select></label>
        <button className="primary" onClick={run} disabled={busy}>{busy ? "Replaying…" : "Run replay"}</button>
      </div>
      {err && <div className="status bad">{err}</div>}
      {res && (
        <>
          <p><strong>{res.changedCount}</strong> of {res.n} decisions changed ({((res.changedCount / res.n) * 100).toFixed(1)}%) · {res.elapsedMs} ms</p>
          <div className="chart">
            <div className="legend"><span className="sw a" /> A: {res.a} <span className="sw b" /> B: {res.b}</div>
            {buckets.map(([name, v]) => (
              <div key={name} className="barrow">
                <div className="barlabel">{name}</div>
                <div className="bars">
                  <div className="bar a" style={{ width: `${(v.a / res.n) * 100}%` }}><span>{v.a}</span></div>
                  <div className="bar b" style={{ width: `${(v.b / res.n) * 100}%` }}><span>{v.b}</span></div>
                </div>
                <div className="barpct">{((v.a / res.n) * 100).toFixed(0)}% → {((v.b / res.n) * 100).toFixed(0)}%</div>
              </div>
            ))}
          </div>
          <h4>Changed decisions {res.changedCount > res.samples.length && <span className="muted">(first {res.samples.length})</span>}</h4>
          {res.samples.length === 0 ? <p className="muted">No differences.</p> : (
            <table><thead><tr><th>Input</th><th>A ({res.a})</th><th>B ({res.b})</th></tr></thead><tbody>
              {res.samples.map((s: any, i: number) => (
                <tr key={i}><td className="mono small">{compact(s.input)}</td><td>{s.a.signature}</td><td>{s.b.signature}</td></tr>
              ))}
            </tbody></table>
          )}
        </>
      )}
    </div>
  );
}

// flatten one level for a readable one-line input summary
const compact = (o: any): string => Object.entries(o).map(([k, v]) => (v && typeof v === "object" ? Object.entries(v as any).map(([k2, v2]) => `${k2}=${v2}`).join(" ") : `${k}=${v}`)).join(" ");
