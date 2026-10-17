import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

export function Scenarios() {
  const { domain, meta } = useStore();
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState("");
  const [res, setRes] = useState<any>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRes(undefined);
    api(`/domains/${domain}/rules/versions`).then((v) => { setVersions(["draft", ...v.versions.map((x: any) => x.version)]); setVersion(v.active); }).catch((e) => setErr(e.message));
  }, [domain, meta?.activeVersion]);

  const run = useCallback(async (v = version) => {
    if (!v) return;
    setBusy(true); setErr(undefined);
    try { setRes(await api(`/domains/${domain}/scenarios/run?version=${v}`, { method: "POST" })); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }, [domain, version]);
  useEffect(() => { if (version) run(version); }, [version]); // eslint-disable-line

  return (
    <div className="page">
      <h3>Scenarios</h3>
      <p className="muted">Each scenario runs on neutral facts (no jitter, no live overrides) so results are repeatable.</p>
      <div className="toolbar plain">
        <label className="inline">Rules <select value={version} onChange={(e) => setVersion(e.target.value)}>{versions.map((o) => <option key={o}>{o}</option>)}</select></label>
        <button className="primary" onClick={() => run()} disabled={busy}>{busy ? "Running…" : "Run all"}</button>
        {res && <span className={`chip ${res.passed === res.total ? "ok" : "bad"}`}>{res.passed}/{res.total} passed</span>}
      </div>
      {err && <div className="status bad">{err}</div>}
      {res?.results.map((r: any) => {
        const sc = meta?.scenarios?.find((s: any) => s.name === r.name);
        return (
          <details key={r.name} className={`scn ${r.pass ? "pass" : "fail"}`} open={!r.pass}>
            <summary><span className={`chip ${r.pass ? "ok" : "bad"}`}>{r.pass ? "PASS" : "FAIL"}</span> {r.name}</summary>
            {sc?.description && <p className="muted">{sc.description}</p>}
            {r.error && <div className="status bad">{r.error}</div>}
            <table><thead><tr><th>Check</th><th>Expected</th><th>Actual</th></tr></thead><tbody>
              {r.checks.map((c: any) => <tr key={c.path} className={c.ok ? "" : "badrow"}><td className="mono">{c.path}</td><td className="mono">{JSON.stringify(c.expected)}</td><td className="mono">{JSON.stringify(c.actual)}</td></tr>)}
            </tbody></table>
          </details>
        );
      })}
    </div>
  );
}
