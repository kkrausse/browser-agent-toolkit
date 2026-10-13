import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "./utils";
export function Input({ className, ...props }: InputPrimitive.Props) {
  return <InputPrimitive data-slot="input" className={cn("oc-ui ocui:block ocui:h-7 ocui:w-full ocui:min-w-0 ocui:rounded-md ocui:border ocui:border-solid ocui:border-line ocui:bg-bg ocui:px-2.5 ocui:text-[13px] ocui:text-fg ocui:placeholder:text-muted ocui:focus-visible:outline-2 ocui:focus-visible:outline-accent ocui:disabled:opacity-50", className)} {...props} />;
}
