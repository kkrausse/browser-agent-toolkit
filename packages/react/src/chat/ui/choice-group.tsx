import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Check } from "lucide-react";
import { cn } from "./utils";

const choiceClass = "oc-ui ocui:mt-0.5 ocui:inline-flex ocui:size-4 ocui:shrink-0 ocui:items-center ocui:justify-center ocui:border ocui:border-solid ocui:border-muted ocui:bg-bg ocui:p-0 ocui:text-primary-fg ocui:data-checked:border-primary ocui:data-checked:bg-primary ocui:focus-visible:outline-2 ocui:focus-visible:outline-offset-1 ocui:focus-visible:outline-accent ocui:data-disabled:opacity-50";
export function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return <CheckboxPrimitive.Root data-slot="checkbox" className={cn(choiceClass, "ocui:rounded-sm", className)} {...props}>
    <CheckboxPrimitive.Indicator className="ocui:flex"><Check className="ocui:size-3" aria-hidden="true" /></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>;
}
export function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props<string>) {
  return <RadioPrimitive.Root data-slot="radio-group-item" className={cn(choiceClass, "ocui:rounded-full", className)} {...props}>
    <RadioPrimitive.Indicator className="ocui:size-1.5 ocui:rounded-full ocui:bg-primary-fg" />
  </RadioPrimitive.Root>;
}
export interface Choice { value: string; label: string; description?: string }
/** One of the options (radios) or any of them (checkboxes). */
export function ChoiceGroup({ label, name, options, value, multiple, disabled, onValueChange }: {
  label: string; name: string; options: readonly Choice[];
  value: readonly string[]; multiple?: boolean; disabled?: boolean; onValueChange(value: string[]): void;
}) {
  const choices = options.map(option => <label className="oc-option" key={option.value}>
    {multiple ? <Checkbox name={name} value={option.value} disabled={disabled} checked={value.includes(option.value)}
      onCheckedChange={checked => onValueChange(checked ? [...value, option.value] : value.filter(item => item !== option.value))} />
      : <RadioGroupItem value={option.value} disabled={disabled} />}
    <span>{option.label}{option.description && <small>{option.description}</small>}</span>
  </label>);
  return multiple ? <div role="group" aria-label={label}>{choices}</div> : <RadioGroup aria-label={label} name={name} value={value[0] ?? ""} disabled={disabled} onValueChange={value => onValueChange([value])}>{choices}</RadioGroup>;
}
