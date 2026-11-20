// Purpose: Render shared Tea parameter controls without owning persistence.
import { useId, useState, type ComponentType } from "react";
import { parseTickerId, tickerId } from "@openchart/feed";
import type { ProviderListing } from "@openchart/market";
import * as Tea from "@openchart/tea";
import { Search } from "lucide-react";
import { Button } from "@openchart/app/components/ui/button";
import { Input } from "@openchart/app/components/ui/input";
import { Switch } from "@openchart/app/components/ui/form/switch";
import { CardItem } from "@openchart/app/components/ui/settings/card";
import { DropdownControl } from "@openchart/app/components/ui/settings/dropdown-control";

// An `input.source` picks one of the Bars columns.
const sourceOptions = Tea.barsSchema.fields.map((field) => field.name);

function parseHexColor(raw: unknown): { hex: string; opacity: number } {
  const value = typeof raw === "string" ? raw.trim() : "";
  const match = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(value);
  if (!match) return { hex: "#000000", opacity: 1 };
  const hex = `#${(match[1] ?? "000000").toLowerCase()}`;
  const alphaHex = match[2];
  const opacity = alphaHex
    ? Math.round((parseInt(alphaHex, 16) / 255) * 100) / 100
    : 1;
  return { hex, opacity };
}

function formatHexColor(hex: string, opacity: number): string {
  const clamped = Math.max(0, Math.min(1, opacity));
  if (clamped >= 1) return hex;
  const alpha = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${alpha}`;
}

type SymbolPicker = ComponentType<{
  initialQuery?: string;
  onSelect: (listing: ProviderListing) => void | Promise<void>;
  onClose: () => void;
}>;

/** Render declarations and explicit overrides without owning a form or persistence. @example <TeaParameterFields parameters={node.parameters} value={draft} onChange={setDraft} /> */
export function TeaParameterFields({
  parameters,
  value: draft,
  onChange,
  choices = {},
  symbolPicker,
  disabled = false,
}: {
  parameters: readonly Tea.Parameter[];
  value: Tea.ParameterOverrides;
  onChange: (value: Tea.ParameterOverrides) => void;
  /**
   * Choices the host offers for a parameter, by name, each with the name it
   * shows, such as the bars a chart can read for an auto script's
   * `timeframe`; `""` shows as "Default". They replace declared options.
   */
  choices?: Readonly<
    Record<string, readonly { readonly value: string; readonly name: string }[]>
  >;
  /** Host search dialog for `input.symbol`; selections become provider-qualified ticker ids. The host owns search, errors and cleanup. Without a picker, symbols use text entry. */
  symbolPicker?: SymbolPicker | null;
  disabled?: boolean;
}) {
  const id = useId();
  const reset = (name: string) => {
    const next = { ...draft };
    delete next[name];
    onChange(next);
  };
  const set = (name: string, value: string | number | boolean) =>
    onChange({ ...draft, [name]: value });
  return (
    <>
      <div className="text-sm">
        {parameters.map((parameter) => {
          const explicit = Object.hasOwn(draft, parameter.name);
          const value = explicit
            ? draft[parameter.name]
            : (parameter.value ?? parameter.defaultValue);
          const numeric =
            parameter.type === "int" || parameter.type === "float";
          const options =
            choices[parameter.name] ??
            (parameter.constraints?.kind === "options"
              ? parameter.constraints.options
              : (parameter.enumType?.members.map((member) => member.name) ??
                (parameter.type === "source" ? sourceOptions : undefined))
            )?.map((option) => ({
              value: String(option),
              name: String(option),
            }));
          const fieldId = `${id}-${parameter.name}`;
          const label = parameter.title || parameter.name;
          return (
            <CardItem
              key={parameter.name}
              className="flex-wrap gap-3"
              classNameWrapperAction="ml-auto max-w-full"
              title={label}
              htmlFor={fieldId}
              actions={
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {explicit ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-label={`Reset ${label}`}
                      disabled={disabled}
                      onClick={() => reset(parameter.name)}
                    >
                      Use script default
                    </Button>
                  ) : null}
                  {parameter.type === "bool" ? (
                    <Switch
                      id={fieldId}
                      checked={value === true}
                      onCheckedChange={(checked) =>
                        set(parameter.name, checked)
                      }
                      disabled={disabled}
                    />
                  ) : parameter.type === "color" ? (
                    (() => {
                      const { hex, opacity } = parseHexColor(value);
                      return (
                        <div className="flex items-center gap-2">
                          <Input
                            id={fieldId}
                            type="color"
                            className="size-8 cursor-pointer p-0.5"
                            value={hex}
                            onChange={(event) =>
                              set(
                                parameter.name,
                                formatHexColor(event.target.value, opacity),
                              )
                            }
                            disabled={disabled}
                          />
                          <input
                            type="range"
                            aria-label={`${label} opacity`}
                            className="w-24 accent-primary"
                            min={0}
                            max={1}
                            step={0.05}
                            value={opacity}
                            onChange={(event) =>
                              set(
                                parameter.name,
                                formatHexColor(hex, Number(event.target.value)),
                              )
                            }
                            disabled={disabled}
                          />
                          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
                            {Math.round(opacity * 100)}%
                          </span>
                        </div>
                      );
                    })()
                  ) : options ? (
                    <div className="w-40">
                      <DropdownControl
                        id={fieldId}
                        value={String(value ?? "")}
                        selectedLabel={
                          value == null
                            ? "Choose a value"
                            : value === "" && choices[parameter.name]
                              ? "Default"
                              : undefined
                        }
                        options={[
                          ...(value == null
                            ? [{ value: "", name: "Choose a value" }]
                            : []),
                          ...options,
                        ]}
                        onChange={(next) =>
                          set(
                            parameter.name,
                            numeric ? Number(next) : String(next),
                          )
                        }
                        disabled={disabled}
                      />
                    </div>
                  ) : parameter.control === "symbol" && symbolPicker ? (
                    <SymbolField
                      id={fieldId}
                      Picker={symbolPicker}
                      value={String(value ?? "")}
                      onChange={(next) => set(parameter.name, next)}
                      disabled={disabled}
                    />
                  ) : (
                    <Input
                      id={fieldId}
                      type={numeric ? "number" : "text"}
                      className={numeric ? "h-8 w-20" : "h-8 w-40"}
                      value={String(value ?? "")}
                      step={parameter.type === "int" ? 1 : "any"}
                      onChange={(event) =>
                        set(parameter.name, event.target.value)
                      }
                      disabled={disabled}
                    />
                  )}
                </div>
              }
            />
          );
        })}
      </div>
      {Object.keys(draft)
        .filter(
          (name) => !parameters.some((parameter) => parameter.name === name),
        )
        .map((name) => (
          <div key={name} role="alert" className="text-sm text-destructive">
            Parameter “{name}” was removed.{" "}
            <Button type="button" variant="link" onClick={() => reset(name)}>
              Remove override
            </Button>
          </div>
        ))}
    </>
  );
}

function SymbolField({
  id,
  Picker,
  value,
  onChange,
  disabled,
}: {
  id: string;
  Picker: SymbolPicker;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        id={id}
        type="button"
        variant="outline"
        size="sm"
        className="w-40 justify-start font-normal"
        title={value || undefined}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Search className="size-3.5 text-muted-foreground" />
        <span className="truncate">{value || "Select symbol"}</span>
      </Button>
      {open ? (
        <Picker
          initialQuery={parseTickerId(value)?.symbol ?? value}
          onClose={() => setOpen(false)}
          onSelect={(listing) => {
            const ticker = tickerId(listing);
            if (!ticker)
              throw new Error("This source does not support script symbols.");
            onChange(ticker);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
