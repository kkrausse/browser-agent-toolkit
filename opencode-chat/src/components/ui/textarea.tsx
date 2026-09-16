import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "./utils";
// shadcn's Base UI textarea uses the native element (Base UI has no textarea primitive).
export const Textarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<"textarea">>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} data-slot="textarea" className={cn("oc-ui ocui:block ocui:min-h-20 ocui:w-full ocui:rounded-md ocui:border ocui:border-solid ocui:border-neutral-300 ocui:bg-white ocui:px-2.5 ocui:py-2 ocui:text-sm ocui:text-neutral-900 ocui:placeholder:text-neutral-500 ocui:focus-visible:outline-2 ocui:focus-visible:outline-neutral-500 ocui:disabled:opacity-50", className)} {...props} />;
});
