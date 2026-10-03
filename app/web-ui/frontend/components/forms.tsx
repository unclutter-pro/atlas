/** Controlled form controls. onChange receives the value, not the event. */

import { useEffect, useId, type ReactNode } from "react";

function Field(props: { id: string; label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="field">
      {props.label && (
        <label className="field-label" htmlFor={props.id}>
          {props.label}
        </label>
      )}
      {props.children}
      {props.error ? <div className="field-error">{props.error}</div> : props.hint && <div className="field-hint">{props.hint}</div>}
    </div>
  );
}

interface Common {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  name?: string;
  placeholder?: string;
  autoFocus?: boolean;
  required?: boolean;
}

export function TextField(props: Common & { value: string; onChange: (value: string) => void; type?: "text" | "password" | "url" | "email" | "number" | "search" | "date" | "datetime-local"; onEnter?: () => void }) {
  const id = useId();
  return (
    <Field id={id} label={props.label} hint={props.hint} error={props.error}>
      <input
        id={id}
        className={`input${props.error ? " has-error" : ""}`}
        type={props.type ?? "text"}
        name={props.name}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        required={props.required}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={props.onEnter ? (e) => e.key === "Enter" && props.onEnter!() : undefined}
      />
    </Field>
  );
}

export function TextArea(props: Common & { value: string; onChange: (value: string) => void; rows?: number; spellCheck?: boolean }) {
  const id = useId();
  return (
    <Field id={id} label={props.label} hint={props.hint} error={props.error}>
      <textarea
        id={id}
        className={`textarea${props.error ? " has-error" : ""}`}
        name={props.name}
        value={props.value}
        rows={props.rows ?? 8}
        placeholder={props.placeholder}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        required={props.required}
        spellCheck={props.spellCheck ?? false}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </Field>
  );
}

export type Option = string | { value: string; label: string };

export function Select(props: Common & { value: string; onChange: (value: string) => void; options: Option[] }) {
  const id = useId();
  return (
    <Field id={id} label={props.label} hint={props.hint} error={props.error}>
      <select id={id} className="select" name={props.name} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value)}>
        {props.options.map((o) => {
          const { value, label } = typeof o === "string" ? { value: o, label: o } : o;
          return (
            <option key={value} value={value}>
              {label}
            </option>
          );
        })}
      </select>
    </Field>
  );
}

export function Toggle(props: { checked: boolean; onChange: (checked: boolean) => void; label?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className={`toggle${props.disabled ? " is-disabled" : ""}`} title={props.title}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track" />
      {props.label && <span>{props.label}</span>}
    </label>
  );
}

/** Button row at the bottom of a form. */
export function FormActions(props: { children: ReactNode }) {
  return <div className="form-actions">{props.children}</div>;
}

/** Ask before closing or reloading the tab while `dirty` (unsaved edits). */
export function useUnsavedWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}
