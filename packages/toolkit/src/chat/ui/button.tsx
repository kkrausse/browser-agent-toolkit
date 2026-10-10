import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

// Adapted from shadcn/ui's Base UI registry; compact neutral defaults.
const buttonVariants = cva(
  "oc-ui ocui:inline-flex ocui:shrink-0 ocui:items-center ocui:justify-center ocui:gap-1.5 ocui:rounded-md ocui:border ocui:border-solid ocui:px-2.5 ocui:py-1 ocui:text-sm ocui:font-medium ocui:whitespace-nowrap ocui:cursor-pointer ocui:focus-visible:outline-2 ocui:focus-visible:outline-offset-2 ocui:focus-visible:outline-neutral-500 ocui:disabled:pointer-events-none ocui:disabled:opacity-50 ocui:[&_svg]:size-4 ocui:[&_svg]:shrink-0",
  { variants: { variant: {
    default: "ocui:border-neutral-900 ocui:bg-neutral-900 ocui:text-white ocui:hover:bg-neutral-700",
    outline: "ocui:border-neutral-300 ocui:bg-white ocui:text-neutral-900 ocui:hover:bg-neutral-100 ocui:aria-expanded:bg-neutral-100",
    ghost: "ocui:border-transparent ocui:bg-transparent ocui:text-neutral-900 ocui:hover:bg-neutral-100",
  } }, defaultVariants: { variant: "outline" } },
);
export function Button({ className, variant, ...props }: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant }), className)} {...props} />;
}
