import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

// Adapted from shadcn/ui's Base UI registry; compact, coloured by the chat's tokens.
const buttonVariants = cva(
  "oc-ui ocui:inline-flex ocui:shrink-0 ocui:items-center ocui:justify-center ocui:gap-1.5 ocui:rounded-md ocui:border ocui:border-solid ocui:font-medium ocui:whitespace-nowrap ocui:cursor-pointer ocui:focus-visible:outline-2 ocui:focus-visible:outline-offset-1 ocui:focus-visible:outline-accent ocui:disabled:pointer-events-none ocui:disabled:opacity-50 ocui:[&_svg]:size-4 ocui:[&_svg]:shrink-0",
  { variants: {
    variant: {
      default: "ocui:border-primary ocui:bg-primary ocui:text-primary-fg ocui:hover:opacity-85",
      outline: "ocui:border-line ocui:bg-bg ocui:text-fg ocui:hover:bg-raised ocui:aria-expanded:bg-raised",
      ghost: "ocui:border-transparent ocui:bg-transparent ocui:text-muted ocui:hover:bg-raised ocui:hover:text-fg ocui:aria-pressed:bg-raised ocui:aria-pressed:text-fg",
      danger: "ocui:border-line ocui:bg-bg ocui:text-danger ocui:hover:bg-raised",
    },
    size: {
      default: "ocui:h-7 ocui:px-2.5 ocui:text-[13px]",
      sm: "ocui:h-6 ocui:px-2 ocui:text-xs",
      icon: "ocui:size-7 ocui:p-0",
      "icon-sm": "ocui:size-6 ocui:p-0 ocui:[&_svg]:size-3.5",
    },
  }, defaultVariants: { variant: "outline", size: "default" } },
);
export function Button({ className, variant, size, ...props }: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
