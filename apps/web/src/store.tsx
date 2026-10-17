import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { DecisionGraphType } from "@gorules/jdm-editor";
import type { Policy } from "@venue/shared";
import { api } from "./api";

export interface Store {
  domains: { name: string; description: string; activeVersion: string }[];
  domain: string;
  setDomain: (d: string) => void;
  meta: any; // domain.json + scenarios + activeVersion
  reloadMeta: () => Promise<void>;
  /** The draft graph lives here so it survives switching tabs. */
  graph?: DecisionGraphType;
  setGraph: (g: DecisionGraphType, dirty?: boolean) => void;
  policy?: Policy;
  setPolicy: (p: Policy) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  setDirty: (d: boolean) => void;
  reloadDraft: () => Promise<void>;
  /** Last input sent from the Decide page (used by Live venues to re-run on toggle). */
  lastInput?: unknown;
  setLastInput: (i: unknown) => void;
  error?: string;
}

const Ctx = createContext<Store>(null as any);
export const useStore = () => useContext(Ctx);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [domains, setDomains] = useState<Store["domains"]>([]);
  const [domain, setDomainState] = useState("");
  const [meta, setMeta] = useState<any>();
  const [graph, setGraphState] = useState<DecisionGraphType>();
  const [policy, setPolicyState] = useState<Policy>();
  const [past, setPast] = useState<Policy[]>([]);
  const [future, setFuture] = useState<Policy[]>([]);
  const [dirty, setDirty] = useState(false);
  const [lastInput, setLastInput] = useState<unknown>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api("/domains").then((d) => { setDomains(d); const want = new URLSearchParams(location.search).get("domain") ?? localStorage.getItem("domain");
      setDomainState(d.some((x: any) => x.name === want) ? want! : d[0]?.name); })
      .catch((e) => setError(`Cannot reach the API: ${e.message}`));
  }, []);

  const reloadMeta = useCallback(async () => { if (domain) setMeta(await api(`/domains/${domain}`)); }, [domain]);
  const reloadDraft = useCallback(async () => {
    if (!domain) return;
    const { policy: p, ...g } = await api(`/domains/${domain}/rules/draft`);
    setGraphState(g); setPolicyState(p); setPast([]); setFuture([]);
    setDirty(false);
  }, [domain]);

  useEffect(() => {
    if (!domain) return;
    setMeta(undefined); setGraphState(undefined); setPolicyState(undefined); setLastInput(undefined); setDirty(false);
    Promise.all([reloadMeta(), reloadDraft()]).catch((e) => setError(e.message));
  }, [domain, reloadMeta, reloadDraft]);

  const setDomain = (d: string) => { localStorage.setItem("domain", d); setDomainState(d); };
  const setPolicy = (p: Policy) => { if (policy) setPast((x) => [...x.slice(-99), policy]); setFuture([]); setPolicyState(p); setDirty(true); };
  const undo = () => { if (!past.length || !policy) return; setFuture((f) => [policy, ...f]); setPolicyState(past[past.length - 1]); setPast(past.slice(0, -1)); setDirty(true); };
  const redo = () => { if (!future.length || !policy) return; setPast((x) => [...x, policy]); setPolicyState(future[0]); setFuture(future.slice(1)); setDirty(true); };
  const setGraph = (g: DecisionGraphType, d = true) => { setGraphState(g); if (d) setDirty(true); };

  return <Ctx.Provider value={{ domains, domain, setDomain, meta, reloadMeta, graph, setGraph, policy, setPolicy, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0, dirty, setDirty, reloadDraft, lastInput, setLastInput, error }}>{children}</Ctx.Provider>;
}
