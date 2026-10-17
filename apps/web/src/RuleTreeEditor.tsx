import { createContext, Fragment, useContext, useMemo, useState } from "react";
import type { ActionDef, ActionInstance, ConditionNode, Group, Policy, RuleField, RuleSetDef, RuleTree, RulesConfig, Test, TreeNode } from "@venue/shared";
import { ancestors, cloneNode, countNodes, defaultValue, describeValue, drop, mapNode, newAction, newGroup, newTest, OP_LABEL, OPS, testIssue, treeIssues, uid, type Payload, type Slot } from "./tree";

interface Ctx {
  set: RuleSetDef;
  rules: RulesConfig;
  fields: Map<string, RuleField>;
  actions: Map<string, ActionDef>;
  update: (treeId: string, fn: (t: RuleTree) => RuleTree) => void;
  place: (slot: Slot, payload: Payload) => void;
  hit: Set<string>;     // leaves that matched in the last test
  onPath: Set<string>;  // their ancestors
  dragging: boolean;
  startDrag: (p: Payload) => void;
  endDrag: () => void;
  clipboard: TreeNode | null;
  copy: (n: TreeNode) => void;
}
const EditorCtx = createContext<Ctx>(null as any);
let dragPayload: Payload | null = null;

const TONE_ICON: Record<string, string> = { good: "✓", warn: "⚑", bad: "⛔", info: "ℹ" };

// ================================================================ editor
export function RuleSetEditor({ set, rules, policy, onChange, hits }: { set: RuleSetDef; rules: RulesConfig; policy: Policy; onChange: (p: Policy) => void; hits?: string[] }) {
  const sp = policy[set.id];
  const fields = useMemo(() => new Map(rules.fields.map((f) => [f.id, f])), [rules]);
  const actions = useMemo(() => new Map(rules.actions.map((a) => [a.id, a])), [rules]);
  const [toast, setToast] = useState("");
  const [dragging, setDragging] = useState(false);
  const [clipboard, setClipboard] = useState<TreeNode | null>(null);

  const setSp = (next: typeof sp) => onChange({ ...policy, [set.id]: next });
  const update = (treeId: string, fn: (t: RuleTree) => RuleTree) => setSp({ ...sp, trees: sp.trees.map((t) => (t.id === treeId ? fn(t) : t)) });
  const place = (slot: Slot, payload: Payload) => {
    const tree = sp.trees.find((t) => t.id === slot.treeId)!;
    const next = drop(tree, slot, payload, set, rules);
    if (!next) { setToast("That can't go there. Conditions can go anywhere; actions need an empty branch."); setTimeout(() => setToast(""), 3500); return; }
    update(slot.treeId, () => next);
  };

  const hit = new Set((hits ?? []).filter(Boolean));
  const onPath = new Set<string>();
  for (const t of sp.trees) for (const h of hit) for (const a of ancestors(t.root, h) ?? []) onPath.add(a);
  const issues = sp.trees.flatMap((t) => treeIssues(t.root, fields));

  const ctx: Ctx = {
    set, rules, fields, actions, update, place, hit, onPath, dragging, clipboard,
    startDrag: (p) => { dragPayload = p; setDragging(true); },
    endDrag: () => { dragPayload = null; setDragging(false); },
    copy: (n) => { setClipboard(cloneNode(n)); setToast("Copied. Use ＋ on any empty branch to paste."); setTimeout(() => setToast(""), 2500); },
  };

  return (
    <EditorCtx.Provider value={ctx}>
      <div className="rt-wrap">
        <div className="rt-canvas">
          <div className="rt-intro">
            <p>{set.description}</p>
            {issues.length > 0 && <span className="pill bad" title={issues.join("\n")}>⚠ {issues.length} thing{issues.length > 1 ? "s" : ""} to fix</span>}
          </div>
          {toast && <div className="rt-toast">{toast}</div>}

          {sp.trees.map((t, i) => (
            <section key={t.id} className="rt-treecard">
              {set.mode === "all" && (
                <header className="rt-treehead">
                  <span className="rt-rulenum">{i + 1}</span>
                  <input className="rt-name" value={t.name ?? ""} placeholder="Name this rule" onChange={(e) => update(t.id, (x) => ({ ...x, name: e.target.value }))} />
                  <button className="icon" title="Delete rule" onClick={() => confirm("Delete this rule?") && setSp({ ...sp, trees: sp.trees.filter((x) => x.id !== t.id) })}>🗑</button>
                </header>
              )}
              <NodeView node={t.root} slot={{ treeId: t.id, kind: "root" }} label="IF" />
            </section>
          ))}
          {set.mode === "all" && <button className="rt-addrule" onClick={() => setSp({ ...sp, trees: [...sp.trees, { id: uid(), name: "", root: null }] })}>＋ Add rule</button>}

          {(sp.default.length > 0 || set.mode === "first") && (
            <section className="rt-default">
              <div className="rt-defhead">Otherwise</div>
              <p className="muted small">Used when no branch above ends in an action.</p>
              {sp.default.map((a, i) => (
                <ActionCard key={i} inst={a} onChange={(n) => setSp({ ...sp, default: sp.default.map((x, j) => (j === i ? n : x)) })} />
              ))}
            </section>
          )}
        </div>
        <Sidebar />
      </div>
    </EditorCtx.Provider>
  );
}

// ================================================================ sidebar
function Sidebar() {
  const { set, rules, startDrag, endDrag } = useContext(EditorCtx);
  const [tab, setTab] = useState<"Conditions" | "Actions">("Conditions");
  const [q, setQ] = useState("");
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const fields = set.fields.map((id) => rules.fields.find((f) => f.id === id)!).filter((f) => f && match(f.label + f.group));
  const groups = [...new Set(fields.map((f) => f.group))];
  const actions = set.actions.map((id) => rules.actions.find((a) => a.id === id)!).filter((a) => a && match(a.label));
  const drag = (p: Payload) => (e: React.DragEvent) => { startDrag(p); e.dataTransfer.effectAllowed = "copyMove"; e.dataTransfer.setData("text/plain", "rule"); };
  return (
    <aside className="rt-side">
      <div className="seg">{(["Conditions", "Actions"] as const).map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}</div>
      <input className="rt-search" placeholder={`Search ${tab.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} />
      <p className="hint">Drag onto a branch, or press <b>＋</b> on a branch and type.</p>
      <div className="rt-list">
        {tab === "Conditions" && groups.map((g) => (
          <div key={g}>
            <div className="rt-group">{g}</div>
            {fields.filter((f) => f.group === g).map((f) => (
              <div key={f.id} className="rt-item" draggable title={f.hint} onDragStart={drag({ type: "condition", fieldId: f.id })} onDragEnd={endDrag}>
                <span className="grip">⠿</span><span>{f.label}</span>
              </div>
            ))}
          </div>
        ))}
        {tab === "Actions" && actions.map((a) => (
          <div key={a.id} className={`rt-item act ${a.tone}`} draggable title={a.description} onDragStart={drag({ type: "action", actionId: a.id })} onDragEnd={endDrag}>
            <span className="grip">⠿</span><span className="ico">{TONE_ICON[a.tone]}</span><span>{a.label}</span>
          </div>
        ))}
        {tab === "Conditions" && !groups.length && <p className="muted">No match.</p>}
      </div>
    </aside>
  );
}

// ================================================================ nodes
function NodeView({ node, slot, label }: { node: TreeNode | null; slot: Slot; label: string }) {
  if (!node) return <SlotView slot={slot} />;
  if (node.type === "actions") return <ActionsNodeView node={node} slot={slot} />;
  return <ConditionView node={node} slot={slot} label={label} />;
}

function ConditionView({ node, slot, label }: { node: ConditionNode; slot: Slot; label: string }) {
  const { update, onPath, startDrag, endDrag, copy } = useContext(EditorCtx);
  const patch = (p: Partial<ConditionNode>) => update(slot.treeId, (t) => ({ ...t, root: mapNode(t.root, node.id, (n) => ({ ...(n as ConditionNode), ...p })) }));
  const remove = () => {
    const n = countNodes(node);
    if (n > 1 && !confirm(`Delete this condition and the ${n - 1} node(s) below it?`)) return;
    update(slot.treeId, (t) => ({ ...t, root: mapNode(t.root, node.id, () => null) }));
  };
  return (
    <div className="rt-cond">
      <div className={`rule ${onPath.has(node.id) ? "onpath" : ""}`}>
        <span className="grip" title="Drag to move this branch" draggable
          onDragStart={(e) => { startDrag({ type: "move", nodeId: node.id, treeId: slot.treeId }); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "move"); }} onDragEnd={endDrag}>⠿</span>
        <div className="rule-main">
          <div className="rule-if">
            <span className="kw">{label}</span>
            <GroupView group={node.when} depth={0} onChange={(when) => patch({ when })} />
          </div>
          {node.collapsed
            ? <div className="rt-collapsed">{countNodes(node) - 1} node(s) hidden</div>
            : <Branch label="Then" tone="then" node={node.then} slot={{ ...slot, kind: "branch", parentId: node.id, branch: "then" } as Slot} />}
        </div>
        <span className="rt-tools">
          <button className="icon" title="Copy this branch" onClick={() => copy(node)}>⧉</button>
          <button className="icon" title={node.collapsed ? "Show branches" : "Hide branches"} onClick={() => patch({ collapsed: !node.collapsed })}>{node.collapsed ? "▸" : "▾"}</button>
          <button className="icon" title="Delete" onClick={remove}>✕</button>
        </span>
      </div>
      {!node.collapsed && (node.else?.type === "condition"
        ? <ConditionView node={node.else} label="Else if" slot={{ ...slot, kind: "branch", parentId: node.id, branch: "else" } as Slot} />
        : <Branch label="Otherwise" tone="else" node={node.else} slot={{ ...slot, kind: "branch", parentId: node.id, branch: "else" } as Slot} />)}
    </div>
  );
}

function Branch({ label, tone, node, slot }: { label: string; tone: string; node: TreeNode | null; slot: Slot }) {
  return (
    <div className={`rt-branch ${tone}`}>
      <span className={`rt-label ${tone}`}>{label}</span>
      <div className="rt-branchbody"><NodeView node={node} slot={slot} label="If" /></div>
    </div>
  );
}

// ================================================================ AND / OR groups
function GroupView({ group, depth, onChange, onRemove }: { group: Group; depth: number; onChange: (g: Group) => void; onRemove?: () => void }) {
  const { set, fields } = useContext(EditorCtx);
  const first = fields.get(set.fields[0])!;
  const setItems = (items: Group["items"]) => onChange({ ...group, items });
  const flip = () => onChange({ ...group, combinator: group.combinator === "and" ? "or" : "and" });
  const multi = group.items.length > 1;
  return (
    <div className={`grp ${group.combinator} ${depth > 0 ? "nested" : ""}`}>
      {group.items.map((it, i) => (
        <Fragment key={it.id}>
          {i > 0 && <button className={`joiner ${group.combinator}`} onClick={flip} title="Click to switch AND / OR">{group.combinator === "and" ? "AND" : "OR"}</button>}
          {it.kind === "group"
            ? <GroupView group={it} depth={depth + 1} onChange={(g) => setItems(group.items.map((x) => (x.id === it.id ? g : x)))} onRemove={() => setItems(group.items.filter((x) => x.id !== it.id))} />
            : <TestRow test={it} canRemove={multi} onChange={(t) => setItems(group.items.map((x) => (x.id === it.id ? t : x)))} onRemove={() => setItems(group.items.filter((x) => x.id !== it.id))} />}
        </Fragment>
      ))}
      {!multi && depth > 0 && <button className={`joiner ${group.combinator}`} onClick={flip} title="Switch between ALL (AND) and ANY (OR)">{group.combinator === "and" ? "ALL" : "ANY"}</button>}
      <span className="grp-add">
        <button className="add-link" title="Add a condition to this group" onClick={() => setItems([...group.items, newTest(first)])}>＋</button>
        <button className="add-link" title="Add a nested group with the opposite AND / OR" onClick={() => setItems([...group.items, newGroup(group.combinator === "and" ? "or" : "and", [newTest(first)])])}>＋( )</button>
        {onRemove && <button className="icon" title="Remove group" onClick={onRemove}>✕</button>}
      </span>
    </div>
  );
}

function TestRow({ test, canRemove, onChange, onRemove }: { test: Test; canRemove: boolean; onChange: (t: Test) => void; onRemove: () => void }) {
  const { fields } = useContext(EditorCtx);
  const field = fields.get(test.field);
  const issue = testIssue(test, field);
  return (
    <div className={`test ${issue ? "invalid" : ""}`} title={issue ?? undefined}>
      <FieldSelect value={test.field} onChange={(id) => { const f = fields.get(id)!; const op = OPS[f.type][0]; onChange({ ...test, field: id, op, value: defaultValue(f, op) }); }} />
      {field && (
        <>
          <select className="sel op" value={test.op} onChange={(e) => {
            const op = e.target.value as Test["op"];
            const list = op === "in" || op === "not in";
            const v = test.value;
            onChange({ ...test, op, value: op === "between" ? [0, 100] : list ? (Array.isArray(v) ? v : v === "" || v == null ? [] : [v]) : Array.isArray(v) ? v[0] ?? defaultValue(field, op) : v });
          }}>
            {OPS[field.type].map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
          </select>
          <ValueInput field={field} op={test.op} value={test.value} onChange={(v) => onChange({ ...test, value: v })} />
        </>
      )}
      {issue && <span className="warn-ico" title={issue}>⚠</span>}
      {canRemove && <button className="icon rm" title="Remove this test" onClick={onRemove}>✕</button>}
    </div>
  );
}

function FieldSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { set, rules } = useContext(EditorCtx);
  const groups = [...new Set(set.fields.map((id) => rules.fields.find((f) => f.id === id)!.group))];
  return (
    <select className="sel field" value={value} onChange={(e) => onChange(e.target.value)}>
      {groups.map((g) => <optgroup key={g} label={g}>{set.fields.map((id) => rules.fields.find((f) => f.id === id)!).filter((f) => f.group === g).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>)}
    </select>
  );
}

function ValueInput({ field, op, value, onChange }: { field: RuleField; op: string; value: unknown; onChange: (v: unknown) => void }) {
  const list = op === "in" || op === "not in";
  if (field.type === "boolean")
    return <select className="sel" value={String(value)} onChange={(e) => onChange(e.target.value === "true")}><option value="true">true</option><option value="false">false</option></select>;
  if (field.type === "percent")
    return <span className="inl"><input type="number" className="num" min={0} max={100} value={Number(value)} onChange={(e) => onChange(Math.max(0, Math.min(100, Number(e.target.value))))} /><span className="muted">% of traffic</span></span>;
  if (op === "between") {
    const [lo, hi] = (value as number[]) ?? [0, 0];
    return <span className="inl"><input type="number" className="num" value={lo} onChange={(e) => onChange([Number(e.target.value), hi])} /><span className="muted">and</span><input type="number" className="num" value={hi} onChange={(e) => onChange([lo, Number(e.target.value)])} /></span>;
  }
  if (field.type === "number")
    return <input type="number" className="num" value={value as number} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} />;
  if (field.type === "enum" && list) {
    const sel = (value as string[]) ?? [];
    return (
      <span className="rt-chips">
        {field.options!.map((o) => <button key={o} className={`chip-toggle ${sel.includes(o) ? "on" : ""}`} onClick={() => onChange(sel.includes(o) ? sel.filter((x) => x !== o) : [...sel, o])}>{o}</button>)}
      </span>
    );
  }
  if (field.type === "enum")
    return <select className="sel" value={String(value)} onChange={(e) => onChange(e.target.value)}>{field.options!.map((o) => <option key={o}>{o}</option>)}</select>;
  return list
    ? <input className="txt" value={describeValue(value)} placeholder="comma separated, e.g. DE, FR" onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
    : <input className="txt" value={String(value ?? "")} placeholder={op === "matches regex" ? "regular expression" : "text"} onChange={(e) => onChange(e.target.value)} />;
}

// ================================================================ actions
function ActionsNodeView({ node, slot }: { node: Extract<TreeNode, { type: "actions" }>; slot: Slot }) {
  const { update, set, hit, startDrag, endDrag } = useContext(EditorCtx);
  const setActions = (actions: ActionInstance[]) => update(slot.treeId, (t) => ({ ...t, root: mapNode(t.root, node.id, () => (actions.length ? { ...node, actions } : null)) }));
  return (
    <div className={`rt-actions ${hit.has(node.id) ? "hit" : ""}`}
      draggable onDragStart={(e) => { startDrag({ type: "move", nodeId: node.id, treeId: slot.treeId }); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", "move"); }} onDragEnd={endDrag}>
      {hit.has(node.id) && <span className="matched">matched</span>}
      {node.actions.map((a, i) => (
        <ActionCard key={i} inst={a} onChange={(n) => setActions(node.actions.map((x, j) => (j === i ? n : x)))} onRemove={() => setActions(node.actions.filter((_, j) => j !== i))} />
      ))}
      {set.multiAction && <SlotView slot={slot} label="Add another action" actionsOnly />}
    </div>
  );
}

function ActionCard({ inst, onChange, onRemove }: { inst: ActionInstance; onChange: (a: ActionInstance) => void; onRemove?: () => void }) {
  const { actions, set } = useContext(EditorCtx);
  const [open, setOpen] = useState(false);
  const def = actions.get(inst.actionId);
  if (!def) return <div className="rt-card act bad">Unknown action {inst.actionId}</div>;
  const allowed = [...new Set([inst.actionId, ...set.actions])].map((id) => actions.get(id)!).filter(Boolean);
  const shown = def.params.filter((p) => inst.params[p.name] !== undefined || p.default !== undefined);
  return (
    <div className={`rt-card act ${def.tone}`}>
      <div className="rt-actrow">
        <span className="ico">{TONE_ICON[def.tone]}</span>
        <select className="sel title" value={inst.actionId} onChange={(e) => onChange(newAction(actions.get(e.target.value)!))}>{allowed.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
      </div>
      {!open && shown.length > 0 && (
        <div className="rt-summary">
          {shown.map((p) => <span key={p.name} className="sum"><span>{p.label.replace(/^Weight: /, "").toLowerCase()}</span> {describeValue(inst.params[p.name] ?? p.default)}</span>)}
        </div>
      )}
      <span className="rt-tools">
        {def.params.length > 0 && <button className="icon" title={open ? "Close settings" : "Edit settings"} onClick={() => setOpen(!open)}>{open ? "▾" : "⚙"}</button>}
        {onRemove && <button className="icon" title="Remove" onClick={onRemove}>✕</button>}
      </span>
      {open && (
        <div className="rt-params">
          {def.params.map((p) => {
            const v = inst.params[p.name] ?? p.default;
            const set1 = (nv: unknown) => onChange({ ...inst, params: { ...inst.params, [p.name]: nv } });
            return (
              <label key={p.name}>
                <span>{p.label}</span>
                {p.type === "enum" ? <select className="sel" value={String(v)} onChange={(e) => set1(e.target.value)}>{p.options!.map((o) => <option key={o}>{o}</option>)}</select>
                  : p.type === "boolean" ? <input type="checkbox" checked={!!v} onChange={(e) => set1(e.target.checked)} />
                  : p.type === "number" && p.max !== undefined && p.max <= 1 ? <span className="rt-slider"><input type="range" min={p.min} max={p.max} step={p.step} value={Number(v)} onChange={(e) => set1(Number(e.target.value))} /><b>{Number(v).toFixed(2)}</b></span>
                  : p.type === "number" ? <input className="num" type="number" min={p.min} max={p.max} step={p.step} value={Number(v)} onChange={(e) => set1(Number(e.target.value))} />
                  : <input className="txt" value={String(v)} onChange={(e) => set1(e.target.value)} />}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ================================================================ empty branch: "+" button that becomes a drop zone while dragging
function SlotView({ slot, label, actionsOnly }: { slot: Slot; label?: string; actionsOnly?: boolean }) {
  const { place, set, rules, dragging, endDrag, clipboard } = useContext(EditorCtx);
  const [over, setOver] = useState(false);
  const [picking, setPicking] = useState(false);
  const accept = () => dragPayload !== null && (!actionsOnly || dragPayload.type === "action");
  const live = dragging && accept();
  return (
    <div className={`rt-slot ${live ? "live" : ""} ${over ? "over" : ""} ${actionsOnly ? "small" : ""}`}
      onDragOver={(e) => { if (accept()) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (dragPayload && accept()) place(slot, dragPayload); endDrag(); }}>
      {picking ? (
        <Picker onClose={() => setPicking(false)} actionsOnly={actionsOnly} clipboard={actionsOnly ? null : clipboard} set={set} rules={rules} onPick={(p) => { place(slot, p); setPicking(false); }} />
      ) : live ? (
        <span className="drophint">Drop here</span>
      ) : (
        <button className="rt-add" title="Add a condition or action" onClick={() => setPicking(true)}><i>＋</i>{label && <span>{label}</span>}</button>
      )}
    </div>
  );
}

function Picker({ onPick, onClose, set, rules, actionsOnly, clipboard }: { onPick: (p: Payload) => void; onClose: () => void; set: RuleSetDef; rules: RulesConfig; actionsOnly?: boolean; clipboard: TreeNode | null }) {
  const [q, setQ] = useState("");
  const m = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const conds = actionsOnly ? [] : set.fields.map((id) => rules.fields.find((f) => f.id === id)!).filter((f) => f && m(f.label + f.group));
  const acts = set.actions.map((id) => rules.actions.find((a) => a.id === id)!).filter((a) => a && m(a.label));
  const first = conds[0] ? ({ type: "condition", fieldId: conds[0].id } as Payload) : acts[0] ? ({ type: "action", actionId: acts[0].id } as Payload) : null;
  return (
    <div className="rt-picker">
      <input autoFocus placeholder="Type a condition or action…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "Enter" && first) onPick(first); }} />
      <div className="rt-picklist">
        {clipboard && !q && <div className="rt-pick paste" onClick={() => onPick({ type: "paste", node: clipboard })}><em>PASTE</em> Copied branch</div>}
        {conds.map((f) => <div key={f.id} className="rt-pick" onClick={() => onPick({ type: "condition", fieldId: f.id })}><em>IF</em>{f.label}<span className="muted"> · {f.group}</span></div>)}
        {acts.map((a) => <div key={a.id} className={`rt-pick act ${a.tone}`} onClick={() => onPick({ type: "action", actionId: a.id })}><em>DO</em>{a.label}</div>)}
        {!conds.length && !acts.length && <div className="muted pad-s">No match</div>}
      </div>
      <button className="link" onClick={onClose}>Cancel</button>
    </div>
  );
}
