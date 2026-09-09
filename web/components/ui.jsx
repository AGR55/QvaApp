import React from "react";

const cx = (...values) => values.filter(Boolean).join(" ");

export function Button({ variant = "secondary", size = "md", className, children, ...props }) {
  return <button className={cx("ui-button", `ui-button-${variant}`, `ui-button-${size}`, className)} {...props}>{children}</button>;
}

export function IconButton({ variant = "secondary", className, children, ...props }) {
  return <Button variant={variant} size="icon" className={cx("ui-icon-button", className)} {...props}>{children}</Button>;
}

export const Input = React.forwardRef(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cx("ui-input", className)} {...props} />;
});

export const Textarea = React.forwardRef(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cx("ui-input ui-textarea", className)} {...props} />;
});

export const Select = React.forwardRef(function Select({ className, children, ...props }, ref) {
  return <select ref={ref} className={cx("ui-input ui-select", className)} {...props}>{children}</select>;
});

export function Field({ label, htmlFor, description, error, children, className }) {
  return (
    <div className={cx("ui-field", error && "ui-field-invalid", className)} data-invalid={error ? "" : undefined}>
      {label ? <label htmlFor={htmlFor}>{label}</label> : null}
      {children}
      {error ? <small className="ui-field-error" role="alert">{error}</small> : description ? <small className="ui-field-description">{description}</small> : null}
    </div>
  );
}

export function Badge({ variant = "neutral", className, children }) {
  return <span className={cx("ui-badge", `ui-badge-${variant}`, className)}>{children}</span>;
}

export function Alert({ variant = "default", className, children, ...props }) {
  return <div className={cx("ui-alert", `ui-alert-${variant}`, className)} role={props.role || "status"} {...props}>{children}</div>;
}

export function Tabs({ items, value, onChange, className }) {
  return <div className={cx("ui-tabs", className)} role="tablist">{items.map((item) => <button key={item.value} type="button" role="tab" aria-selected={value === item.value} className={value === item.value ? "selected" : ""} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}

