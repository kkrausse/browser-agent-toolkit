import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "./utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return <SelectPrimitive.Trigger data-slot="select-trigger" className={cn("oc-ui ocui:inline-flex ocui:min-w-0 ocui:max-w-full ocui:items-center ocui:justify-between ocui:gap-1.5 ocui:rounded-md ocui:border ocui:border-solid ocui:border-neutral-300 ocui:bg-white ocui:px-2.5 ocui:py-1 ocui:text-sm ocui:text-neutral-900 ocui:focus-visible:outline-2 ocui:focus-visible:outline-neutral-500 ocui:disabled:opacity-50", className)} {...props}>
    {children}<SelectPrimitive.Icon><ChevronDown aria-hidden="true" className="ocui:size-4 ocui:shrink-0" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>;
}
export function SelectContent({ className, children, ...props }: SelectPrimitive.Popup.Props) {
  return <SelectPrimitive.Portal><SelectPrimitive.Positioner sideOffset={4} alignItemWithTrigger={false} className="oc-ui ocui:z-50">
    <SelectPrimitive.Popup data-slot="select-content" className={cn("oc-ui ocui:max-h-(--available-height) ocui:min-w-(--anchor-width) ocui:max-w-[calc(100vw-2rem)] ocui:overflow-y-auto ocui:rounded-md ocui:border ocui:border-solid ocui:border-neutral-300 ocui:bg-white ocui:p-1 ocui:text-sm ocui:text-neutral-900 ocui:shadow-md", className)} {...props}>
      <SelectPrimitive.List>{children}</SelectPrimitive.List>
    </SelectPrimitive.Popup>
  </SelectPrimitive.Positioner></SelectPrimitive.Portal>;
}
export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return <SelectPrimitive.Item data-slot="select-item" className={cn("ocui:relative ocui:flex ocui:cursor-default ocui:items-center ocui:gap-2 ocui:rounded-sm ocui:py-1 ocui:pr-8 ocui:pl-2 ocui:outline-none ocui:data-highlighted:bg-neutral-100 ocui:data-disabled:opacity-50", className)} {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="ocui:absolute ocui:right-2"><Check aria-hidden="true" className="ocui:size-4" /></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>;
}

/** Package-owned composition shared by session, model and source controls. */
export function ChoiceSelect({ label, value, items, placeholder, disabled, onValueChange }: {
  label: string; value: string; items: { value: string; label: string }[];
  placeholder?: string; disabled?: boolean; onValueChange(value: string): void;
}) {
  return <Select items={items} value={value || null} disabled={disabled} onValueChange={value => { if (value !== null) onValueChange(value); }}>
    <SelectTrigger aria-label={label}><SelectValue className="ocui:truncate" placeholder={placeholder} /></SelectTrigger>
    <SelectContent>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
  </Select>;
}
