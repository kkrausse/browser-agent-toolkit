import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "./utils";
export function Input({ className, ...props }: InputPrimitive.Props) {
  return <InputPrimitive data-slot="input" className={cn("oc-ui ocui:block ocui:w-full ocui:min-w-0 ocui:rounded-md ocui:border ocui:border-solid ocui:border-neutral-300 ocui:bg-white ocui:px-2.5 ocui:py-1 ocui:text-sm ocui:text-neutral-900 ocui:focus-visible:outline-2 ocui:focus-visible:outline-neutral-500 ocui:disabled:opacity-50", className)} {...props} />;
}
