import React from "react";
import { Badge as ShadcnBadge } from "./ui/badge.tsx";
import { Button as ShadcnButton } from "./ui/button.tsx";
import { Field as ShadcnField, FieldDescription, FieldError, FieldLabel } from "./ui/field.tsx";
import { Input as ShadcnInput } from "./ui/input.tsx";
import { Select as ShadcnSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { Textarea as ShadcnTextarea } from "./ui/textarea.tsx";

const cx = (...values) => values.filter(Boolean).join(" ");

export const Button = React.forwardRef(function Button({ variant = "secondary", size = "md", className, children, ...props }, ref) {
  const shadcnVariant = { primary: "default", secondary: "secondary", outline: "outline", ghost: "ghost", destructive: "destructive" }[variant] || "secondary";
  const shadcnSize = { sm: "sm", icon: "icon", md: "default" }[size] || "default";
  return <ShadcnButton ref={ref} variant={shadcnVariant} size={shadcnSize} className={cx("ui-button", className)} {...props}>{children}</ShadcnButton>;
});

export function IconButton({ variant = "secondary", className, children, ...props }) {
  return <Button variant={variant} size="icon" className={cx("ui-icon-button", "icon-action", className)} {...props}>{children}</Button>;
}

export const Input = React.forwardRef(function Input({ className, ...props }, ref) {
  return <ShadcnInput ref={ref} className={cx("ui-input", className)} {...props} />;
});

export const Textarea = React.forwardRef(function Textarea({ className, ...props }, ref) {
  return <ShadcnTextarea ref={ref} className={cx("ui-input ui-textarea", className)} {...props} />;
});

export function Select({ id, value, defaultValue, disabled, onValueChange, placeholder, options, className, ...props }) {
  return <ShadcnSelect value={value} defaultValue={defaultValue} disabled={disabled} onValueChange={onValueChange} {...props}>
    <SelectTrigger id={id} className={cx("ui-select", className)}>
      <SelectValue placeholder={placeholder} />
    </SelectTrigger>
    <SelectContent>
      {options.map((option) => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </ShadcnSelect>;
}

export function Field({ label, htmlFor, description, error, children, className }) {
  return (
    <ShadcnField className={cx("ui-field", error && "ui-field-invalid", className)} data-invalid={error ? "true" : undefined}>
      {label ? <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel> : null}
      {children}
      {error ? <FieldError className="ui-field-error">{error}</FieldError> : description ? <FieldDescription className="ui-field-description">{description}</FieldDescription> : null}
    </ShadcnField>
  );
}

export function Badge({ variant = "neutral", className, children }) {
  const shadcnVariant = variant === "danger"
    ? "destructive"
    : variant === "neutral" || variant === "info"
      ? "secondary"
      : "outline";
  return <ShadcnBadge variant={shadcnVariant} className={cx("ui-badge", `ui-badge-${variant}`, className)}>{children}</ShadcnBadge>;
}

export function CardTitle({ className, children }) {
  return <h2 className={cx("ui-card-title", className)}>{children}</h2>;
}

export function Tabs({ items, value, onChange, className }) {
  return <ToggleGroup type="single" value={value} onValueChange={(nextValue) => nextValue && onChange(nextValue)} className={cx("ui-tabs", className)}>{items.map((item) => <ToggleGroupItem key={item.value} value={item.value} className={value === item.value ? "selected" : ""}>{item.label}</ToggleGroupItem>)}</ToggleGroup>;
}
