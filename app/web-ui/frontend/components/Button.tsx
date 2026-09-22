import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link } from "../router";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Shows "…" and disables while true. */
  pending?: boolean;
  type?: "button" | "submit";
};

export function buttonClass(variant: ButtonVariant = "secondary", size: "sm" | "md" = "md", extra?: string): string {
  return ["btn", `btn-${variant}`, size === "sm" && "btn-sm", extra].filter(Boolean).join(" ");
}

export function Button({ variant, size, pending, className, disabled, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} disabled={disabled || pending} {...rest}>
      {children}
      {pending && "…"}
    </button>
  );
}

/** A link styled as a button (client-side navigation). */
export function ButtonLink(props: { href: string; variant?: ButtonVariant; size?: "sm" | "md"; children: ReactNode }) {
  return (
    <Link href={props.href} className={buttonClass(props.variant, props.size)}>
      {props.children}
    </Link>
  );
}

/**
 * Two-step button for destructive actions: the first click swaps in an
 * inline "<prompt> [Confirm] [Cancel]"; Escape or Cancel backs out.
 */
export function ConfirmButton(props: {
  onConfirm: () => unknown | Promise<unknown>;
  children: ReactNode;
  /** Question shown while confirming. */
  prompt?: ReactNode;
  confirmLabel?: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  disabled?: boolean;
  pending?: boolean;
  title?: string;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setConfirming(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  if (!confirming) {
    return (
      <Button
        variant={props.variant ?? "danger"}
        size={props.size}
        disabled={props.disabled}
        pending={props.pending}
        title={props.title}
        onClick={() => setConfirming(true)}
      >
        {props.children}
      </Button>
    );
  }

  return (
    <span className="confirm-inline">
      <span>{props.prompt ?? "Are you sure?"}</span>
      <Button
        variant="danger-solid"
        size={props.size ?? "sm"}
        autoFocus
        pending={props.pending}
        onClick={async () => {
          await props.onConfirm();
          setConfirming(false);
        }}
      >
        {props.confirmLabel ?? "Confirm"}
      </Button>
      <Button variant="ghost" size={props.size ?? "sm"} onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </span>
  );
}

/** Copy-to-clipboard button. `text` may be async, e.g. a secret fetched only on click. */
export function CopyButton(props: { text: string | (() => Promise<string>); label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-sm${props.className ? ` ${props.className}` : ""}`}
      onClick={async () => {
        try {
          const text = typeof props.text === "string" ? props.text : await props.text();
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1400);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : (props.label ?? "Copy")}
    </button>
  );
}
