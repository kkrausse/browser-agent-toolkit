import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "./utils";
// shadcn's Base UI textarea uses the native element (Base UI has no textarea primitive).
export const Textarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<"textarea">>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} data-slot="textarea" className={cn("oc-ui ocui:block ocui:w-full ocui:border-0 ocui:bg-transparent ocui:p-0 ocui:text-sm ocui:text-fg ocui:placeholder:text-muted ocui:outline-none ocui:disabled:opacity-50", className)} {...props} />;
});
