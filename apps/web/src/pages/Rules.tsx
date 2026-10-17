import { useCallback, useEffect, useRef, useState } from "react";
import { DecisionGraph, GraphSimulator, type DecisionGraphType, type Simulation } from "@gorules/jdm-editor";
import { api } from "../api";
import { Result } from "../Result";
import { RuleSetEditor } from "../RuleTreeEditor";
import { defaults, SchemaForm } from "../SchemaForm";
import { useStore } from "../store";

export function Rules() {
  const { domain, meta, reloadMeta, graph, setGraph, policy, setPolicy, undo, redo, canUndo, canRedo, dirty, setDirty, reloadDraft } = useStore();
  const [status, setStatus] = useState<{ text: string; bad?: boolean }>({ text: "" });
  const [simulate, setSimulate] = useState<Simulation>();
  const [running, setRunning] = useState(false);
  const [versions, setVersions] = useState<{ active: string; versions: any[] }>({ active: "", versions: [] });
  const [picked, setPicked] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [author, setAuthor] = useState(() => localStorage.getItem("author") ?? "");
  const [note, setNote] = useState("");
  const [tab, setTab] = useState(() => new URLSearchParams(location.search).get("tab") ?? "");
  const [testOpen, setTestOpen] = useState(false);
  const [testInput, setTestInput] = useState<any>();
  const [testOut, setTestOut] = useState<any>();
  const [testTrace, setTestTrace] = useState<Record<string, any>>();
  const [testErr, setTestErr] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [graphKey, setGraphKey] = useState(0); // bump to remount the editor after the draft is replaced
  // The editor fires onChange while mounting; that is not a user edit, so ignore the first second.
  const mountedAt = useRef(Date.now());
  useEffect(() => { mountedAt.current = Date.now(); }, [domain, graphKey]);

  const loadVersions = useCallback(async () => {
    const v = await api(`/domains/${domain}/rules/versions`);
    setVersions(v);
    setPicked((p) => p || v.active);
  }, [domain]);
  useEffect(() => { setPicked(""); loadVersions().catch((e) => setStatus({ text: e.message, bad: true })); }, [loadVersions]);

  const ok = (text: string) => setStatus({ text });
  const fail = (e: any) => setStatus({ text: e.message, bad: true });

  const save = useCallback(async (g: DecisionGraphType | undefined = graph) => {
    try { await api(`/domains/${domain}/rules/draft`, { method: "PUT", body: policy ? { ...g, policy } : g }); setDirty(false); ok(`Draft saved ${new Date().toLocaleTimeString()}`); return true; }
    catch (e) { fail(e); return false; }
  }, [domain, graph, policy, setDirty]);

  // The server only simulates the saved draft, so save the current graph first.
  const run = useCallback(async ({ graph: g, context }: { graph: DecisionGraphType; context: unknown }) => {
    setRunning(true);
    try {
      if (!(await save(g))) return;
      const out = await api(`/domains/${domain}/simulate`, { method: "POST", body: { context } });
      setSimulate({ result: { performance: out.performance, result: out.result, trace: out.trace, snapshot: g } });
    } catch (e: any) {
      setSimulate({ error: { title: "Simulation failed", message: e.message, data: {} } });
    } finally { setRunning(false); }
  }, [domain, save]);

  const publish = async () => {
    if (!(await save())) return;
    try {
      localStorage.setItem("author", author);
      const m = await api(`/domains/${domain}/rules/publish`, { method: "POST", body: { author: author || "anonymous", note } });
      setPublishing(false); setNote("");
      await loadVersions(); setPicked(m.version);
      ok(`Published ${m.version}. Not active yet: pick it and press Activate.`);
    } catch (e) { fail(e); }
  };

  const activate = async () => {
    try {
      await api(`/domains/${domain}/rules/activate/${picked}`, { method: "POST" });
      await Promise.all([loadVersions(), reloadMeta()]);
      ok(`${picked} is now active`);
    } catch (e) { fail(e); }
  };

  const loadIntoDraft = async () => {
    if (dirty && !confirm("Replace your unsaved draft with " + picked + "?")) return;
    try {
      await api(`/domains/${domain}/rules/draft/from/${picked}`, { method: "POST" });
      await reloadDraft(); setGraphKey((k) => k + 1); setSimulate(undefined);
      ok(`Draft replaced with ${picked}`);
    } catch (e) { fail(e); }
  };

  const rules = meta?.rules;
  const sets: any[] = rules?.sets ?? [];
  const activeTab = tab || sets[0]?.id || "pipeline";
  const activeSet = sets.find((x) => x.id === activeTab);

  const runTest = async () => {
    setTesting(true); setTestErr(undefined);
    try {
      if (dirty && !(await save())) return;
      const r = await api(`/domains/${domain}/simulate`, { method: "POST", body: { context: testInput } });
      setTestOut({ ...r.result, ruleVersion: "draft", latencyMs: r.latencyMs }); setTestTrace(r.trace);
    } catch (e: any) { setTestErr(e.message); setTestOut(undefined); setTestTrace(undefined); }
    finally { setTesting(false); }
  };
  // deep link: ?autotest=<scenario index> opens the test panel on that scenario and runs it
  const autoDone = useRef(false);
  useEffect(() => {
    const idx = new URLSearchParams(location.search).get("autotest");
    if (idx === null || autoDone.current || !meta?.scenarios?.[Number(idx)] || !graph) return;
    autoDone.current = true;
    const input = structuredClone(meta.scenarios[Number(idx)].input);
    setTestOpen(true); setTestInput(input);
    api(`/domains/${domain}/simulate`, { method: "POST", body: { context: input } })
      .then((r) => { setTestOut({ ...r.result, ruleVersion: "draft", latencyMs: r.latencyMs }); setTestTrace(r.trace); })
      .catch((e) => setTestErr(e.message));
  }, [meta, graph, domain]);
  // Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z (undo/redo) and Cmd/Ctrl+S (save), except while typing in a text box
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const typing = ["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName) && (e.target as HTMLInputElement).type !== "checkbox";
      if (e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty) save(); }
      else if (e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const hitsFor = (set: any): string[] => {
    const h = testTrace?.[set.node]?.output?.[`${set.id}__hit`];
    return Array.isArray(h) ? h : h && h !== "default" ? [h] : [];
  };

  if (!graph) return <div className="pad">Loading rules…</div>;
  const first = meta?.scenarios?.[0]?.input ?? {};
  const pickedMeta = versions.versions.find((v) => v.version === picked);

  return (
    <div className="rules">
      <div className="toolbar">
        <label className="inline">Version
          <select className="domainsel" value={picked} onChange={(e) => setPicked(e.target.value)}>
            {versions.versions.map((v) => <option key={v.version} value={v.version}>{v.version}{v.version === versions.active ? " · active" : ""}</option>)}
          </select>
        </label>
        <button onClick={activate} disabled={!picked || picked === versions.active}>{picked && versions.active && Number(picked.slice(1)) < Number(versions.active.slice(1)) ? "Roll back to this" : "Activate"}</button>
        <button onClick={loadIntoDraft} disabled={!picked} title="Replace the draft with this version">Edit a copy</button>
        <span className="muted small">{pickedMeta && `${pickedMeta.author}: ${pickedMeta.note || "(no note)"}`}</span>
        <span className="right pill" style={dirty ? { background: "var(--warn-soft)", color: "var(--warn)" } : undefined}>{dirty ? "● Unsaved changes" : "✓ Draft saved"}</span>
        <button onClick={() => save()} disabled={!dirty}>Save draft</button>
        <button className="primary" onClick={() => setPublishing(!publishing)}>Publish…</button>
      </div>
      {publishing && (
        <div className="toolbar sub">
          <input placeholder="Author" value={author} onChange={(e) => setAuthor(e.target.value)} />
          <input placeholder="Note (what changed?)" style={{ width: 360 }} value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="primary" onClick={publish}>Publish draft as new version</button>
          <button onClick={() => setPublishing(false)}>Cancel</button>
        </div>
      )}
      {status.text && <div className={`status ${status.bad ? "bad" : ""}`}>{status.text}</div>}
      {rules && policy && (
        <div className="rt-tabsbar">
          {sets.map((x) => <button key={x.id} className={activeTab === x.id ? "on" : ""} onClick={() => setTab(x.id)}>{x.title}</button>)}
          <button className={activeTab === "pipeline" ? "on" : ""} onClick={() => setTab("pipeline")}>Pipeline (advanced)</button>
          <span className="right" />
          <button className="icon" title="Undo (Cmd/Ctrl+Z)" disabled={!canUndo} onClick={undo}>↶</button>
          <button className="icon" title="Redo (Shift+Cmd/Ctrl+Z)" disabled={!canRedo} onClick={redo}>↷</button>
          <button className="primary" onClick={() => { setTestOpen(!testOpen); if (!testInput) setTestInput(structuredClone(first.customer || first.txn || Object.keys(first).length ? first : defaults(meta.inputSchema))); }}>{testOpen ? "Hide test panel" : "▶ Test rules"}</button>
        </div>
      )}
      <div className="rt-body">
        {activeSet && rules && policy ? (
          <div className="rt-scroll"><RuleSetEditor key={activeSet.id} set={activeSet} rules={rules} policy={policy} onChange={setPolicy} hits={hitsFor(activeSet)} /></div>
        ) : (
          <div className="graph">
            {rules && <div className="status">Nodes generated from your rules (Strategy, Venue availability, Guardrails…) are rebuilt from the visual rules every time you save. Edit those on their own tabs.</div>}
            <DecisionGraph
              key={`${domain}-${graphKey}`}
              value={graph}
              onChange={(g) => setGraph(g as DecisionGraphType, Date.now() - mountedAt.current > 1000)}
              simulate={simulate}
              panels={[{
                id: "simulator", title: "Simulator", icon: <span>▶</span>,
                renderPanel: () => <GraphSimulator defaultRequest={JSON.stringify(first, null, 2)} loading={running} onRun={run} onClear={() => setSimulate(undefined)} />,
              }]}
            />
          </div>
        )}
        {testOpen && activeSet && (
          <div className="rt-test">
            <div className="rt-testform">
              <h4>Test input</h4>
              <label className="inline">Preset
                <select value="" onChange={(e) => { const sc = meta.scenarios[Number(e.target.value)]; if (sc) { setTestInput(structuredClone(sc.input)); setTestOut(undefined); setTestTrace(undefined); } }}>
                  <option value="">Load a scenario…</option>
                  {meta.scenarios.map((sc: any, i: number) => <option key={sc.name} value={i}>{sc.name}</option>)}
                </select>
              </label>
              {testInput && <SchemaForm schema={meta.inputSchema} value={testInput} onChange={setTestInput} />}
              <button className="primary" onClick={runTest} disabled={testing}>{testing ? "Running…" : "Run on draft"}</button>
              <p className="muted small">Runs on the server with live facts. The branch that matched is highlighted in green.</p>
            </div>
            <div className="rt-testout">
              <h4>Result</h4>
              {testErr && <div className="status bad">{testErr}</div>}
              {!testOut && !testErr && <p className="muted">Run a test to see the decision.</p>}
              <Result out={testOut} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
