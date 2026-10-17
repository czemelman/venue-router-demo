/** Minimal JSON Schema form: objects, enums, numbers, strings, booleans. Enough for domain input schemas. */
export function defaults(schema: any): any {
  if (!schema) return undefined;
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, defaults(v)]));
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  return "";
}

export function SchemaForm({ schema, value, onChange, path = "" }: { schema: any; value: any; onChange: (v: any) => void; path?: string }) {
  if (schema?.type === "object") {
    return (
      <div className={path ? "fieldset" : undefined}>
        {path && <div className="legend">{path.split(".").pop()}</div>}
        <div className="grid">
          {Object.entries<any>(schema.properties ?? {}).map(([key, sub]) =>
            sub.type === "object" ? (
              <div key={key} style={{ gridColumn: "1 / -1" }}>
                <SchemaForm schema={sub} value={value?.[key] ?? {}} path={path ? `${path}.${key}` : key} onChange={(v) => onChange({ ...value, [key]: v })} />
              </div>
            ) : (
              <label key={key}>
                <span>{sub.title ?? key}</span>
                <Field schema={sub} value={value?.[key]} onChange={(v) => onChange({ ...value, [key]: v })} />
              </label>
            ),
          )}
        </div>
      </div>
    );
  }
  return <Field schema={schema} value={value} onChange={onChange} />;
}

function Field({ schema, value, onChange }: { schema: any; value: any; onChange: (v: any) => void }) {
  if (schema.enum)
    return <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>{schema.enum.map((o: string) => <option key={o}>{o}</option>)}</select>;
  if (schema.type === "number" || schema.type === "integer")
    return <input type="number" value={value ?? ""} min={schema.minimum} max={schema.maximum} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />;
  if (schema.type === "boolean")
    return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  return <input type="text" value={value ?? ""} placeholder={schema.format === "date-time" ? "2026-10-14T12:00:00Z" : ""} onChange={(e) => onChange(e.target.value)} />;
}
