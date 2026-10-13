import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { useChatTheme } from "../theme";
import { cn } from "./utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return <SelectPrimitive.Trigger data-slot="select-trigger" className={cn("oc-ui ocui:inline-flex ocui:h-7 ocui:min-w-0 ocui:max-w-full ocui:cursor-pointer ocui:items-center ocui:justify-between ocui:gap-1 ocui:rounded-md ocui:border ocui:border-solid ocui:border-line ocui:bg-bg ocui:px-2 ocui:text-[13px] ocui:text-fg ocui:hover:bg-raised ocui:focus-visible:outline-2 ocui:focus-visible:outline-accent ocui:disabled:pointer-events-none ocui:disabled:opacity-50", className)} {...props}>
    {children}<SelectPrimitive.Icon className="ocui:flex ocui:text-muted"><ChevronDown aria-hidden="true" className="ocui:size-3.5 ocui:shrink-0" /></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>;
}
/** The popup is outside the chat's element, so it is told the chat's scheme. */
export function SelectContent({ className, children, ...props }: SelectPrimitive.Popup.Props) {
  const theme = useChatTheme();
  return <SelectPrimitive.Portal><SelectPrimitive.Positioner sideOffset={4} alignItemWithTrigger={false} className="oc-ui oc-popup ocui:z-50" data-theme={theme}>
    <SelectPrimitive.Popup data-slot="select-content" className={cn("oc-ui ocui:max-h-(--available-height) ocui:min-w-(--anchor-width) ocui:max-w-[min(calc(100vw-2rem),26rem)] ocui:overflow-y-auto ocui:rounded-md ocui:border ocui:border-solid ocui:border-line ocui:bg-bg ocui:p-1 ocui:text-[13px] ocui:text-fg ocui:shadow-lg", className)} {...props}>
      <SelectPrimitive.List>{children}</SelectPrimitive.List>
    </SelectPrimitive.Popup>
  </SelectPrimitive.Positioner></SelectPrimitive.Portal>;
}
export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return <SelectPrimitive.Item data-slot="select-item" className={cn("ocui:relative ocui:flex ocui:cursor-default ocui:items-center ocui:gap-2 ocui:rounded-sm ocui:py-1 ocui:pr-8 ocui:pl-2 ocui:outline-none ocui:data-highlighted:bg-raised ocui:data-disabled:opacity-50", className)} {...props}>
    <SelectPrimitive.ItemText className="ocui:truncate">{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="ocui:absolute ocui:right-2 ocui:flex"><Check aria-hidden="true" className="ocui:size-3.5" /></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>;
}
export function SelectGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return <SelectPrimitive.Group>
    <SelectPrimitive.GroupLabel className="ocui:px-2 ocui:pt-1.5 ocui:pb-0.5 ocui:text-[11px] ocui:font-semibold ocui:tracking-wide ocui:text-muted ocui:uppercase">{label}</SelectPrimitive.GroupLabel>
    {children}
  </SelectPrimitive.Group>;
}

export interface SelectChoice { value: string; label: string; group?: string }
/** Package-owned composition shared by the session, model and form controls. Items that
 * name a `group` are listed under it, groups in the order they first appear. */
export function ChoiceSelect({ label, value, items, placeholder, disabled, className, onValueChange }: {
  label: string; value: string; items: readonly SelectChoice[];
  placeholder?: string; disabled?: boolean; className?: string; onValueChange(value: string): void;
}) {
  const groups = new Map<string, SelectChoice[]>();
  for (const item of items) groups.set(item.group ?? "", [...(groups.get(item.group ?? "") ?? []), item]);
  const option = (item: SelectChoice) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>;
  return <Select items={items as SelectChoice[]} value={value || null} disabled={disabled} onValueChange={value => { if (value !== null) onValueChange(value); }}>
    <SelectTrigger aria-label={label} className={className}>
      <SelectValue className="ocui:truncate" placeholder={placeholder}>
        {selected => selected === null ? placeholder : items.find(item => item.value === selected)?.label ?? selected}
      </SelectValue>
    </SelectTrigger>
    <SelectContent>{[...groups].map(([group, members]) => group ? <SelectGroup key={group} label={group}>{members.map(option)}</SelectGroup> : members.map(option))}</SelectContent>
  </Select>;
}
