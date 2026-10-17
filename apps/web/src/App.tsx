import { useState } from "react";
import { Decide } from "./pages/Decide";
import { Live } from "./pages/Live";
import { Replay } from "./pages/Replay";
import { Rules } from "./pages/Rules";
import { Scenarios } from "./pages/Scenarios";
import { StoreProvider, useStore } from "./store";
import "./styles.css";

const TABS = { Rules, Decide, "Live venues": Live, Replay, Scenarios };
type Tab = keyof typeof TABS;

function Shell() {
  const { domains, domain, setDomain, meta, error, dirty } = useStore();
  const initial = decodeURIComponent(location.hash.slice(1)) as Tab;
  const [tab, setTab] = useState<Tab>(initial in TABS ? initial : "Rules");
  const go = (t: Tab) => { location.hash = t; setTab(t); };
  const Page = TABS[tab];
  return (
    <div className="shell">
      <header className="top">
        <span className="brand"><i />Rule Studio</span>
        <select className="domainsel" value={domain} onChange={(e) => setDomain(e.target.value)}>{domains.map((d) => <option key={d.name}>{d.name}</option>)}</select>
        <nav className="tabs">{(Object.keys(TABS) as Tab[]).map((t) => <button key={t} className={t === tab ? "active" : ""} onClick={() => go(t)}>{t}{t === "Rules" && dirty ? " •" : ""}</button>)}</nav>
        <span className="right">{meta && <span className="pill ok">active {meta.activeVersion}</span>}</span>
      </header>
      {error ? <div className="status bad pad">{error}</div> : domain ? <main><Page key={domain} /></main> : <div className="pad">Loading…</div>}
    </div>
  );
}
export const App = () => <StoreProvider><Shell /></StoreProvider>;
