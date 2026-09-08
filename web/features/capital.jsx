import React from "react";
import { CapitalWorkspace } from "./capital-workspace.jsx";

export function Capital({ data, label, unit, onChanged, resources }) {
  return (
    <CapitalWorkspace data={data} label={label} unit={unit} onChanged={onChanged} resources={resources} />
  );
}
