import { useEffect, useState } from "react";
import { api } from "../api";
import { Result } from "../Result";
import { defaults, SchemaForm } from "../SchemaForm";
import { useStore } from "../store";

export function Decide() {
  const { domain, meta, setLastInput, lastInput } = useStore();
  const [input, setInput] = useState<any>();
  const [out, setOut] = useState<any>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (meta) setInput((lastInput as any) ?? defaults(meta.inputSchema)); setOut(undefined); }, [meta]); // eslint-disable-line

  if (!meta || !input) return <div className="pad">Loading…</div>;

  const decide = async () => {
    setBusy(true); setErr(undefined);
    try { const r = await api(`/domains/${domain}/decide?trace=1`, { method: "POST", body: input }); setOut(r); setLastInput(input); }
    catch (e: any) { setErr(e.message); setOut(undefined); }
    finally { setBusy(false); }
  };

  return (
    <div className="page two-col">
      <div className="panel">
        <h3>Request</h3>
        <label className="inline">Preset
          <select value="" onChange={(e) => { const s = meta.scenarios[Number(e.target.value)]; if (s) { setInput(structuredClone(s.input)); setOut(undefined); } }}>
            <option value="">Load a scenario…</option>
            {meta.scenarios.map((s: any, i: number) => <option key={s.name} value={i}>{s.name}</option>)}
          </select>
        </label>
        <SchemaForm schema={meta.inputSchema} value={input} onChange={setInput} />
        <button className="primary" onClick={decide} disabled={busy}>{busy ? "Deciding…" : `Decide (active ${meta.activeVersion})`}</button>
        <p className="muted">Uses the active published version and current live facts. Each call is added to the decision log.</p>
      </div>
      <div className="panel wide">
        <h3>Decision</h3>
        {err && <div className="status bad">{err}</div>}
        {!out && !err && <p className="muted">Fill in the request and press Decide.</p>}
        <Result out={out} trace={out?.trace} />
      </div>
    </div>
  );
}
