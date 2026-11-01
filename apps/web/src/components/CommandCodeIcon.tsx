import type { ImgHTMLAttributes } from "react";

import commandCodeIconUrl from "../../../../assets/providers/command-code.png";

import { cn } from "~/lib/utils";

/** The Command Code app mark, drawn as a tile so it reads on light and dark backgrounds. */
export function CommandCodeIcon({
  className,
  ...props
}: { readonly className?: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt">) {
  return (
    <img
      {...props}
      src={commandCodeIconUrl}
      alt=""
      aria-hidden
      className={cn("shrink-0 rounded", className)}
    />
  );
}
