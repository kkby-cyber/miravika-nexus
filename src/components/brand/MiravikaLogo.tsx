import logo from "@/assets/miravika-logo.png.asset.json";
import { cn } from "@/lib/utils";

/**
 * Official MIRAVIKA brand mark. The uploaded asset is used as-is — never
 * recoloured, redrawn or stretched (aspect ratio is preserved by `h-auto`).
 */
export function MiravikaLogo({
  className,
  size = 48,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <img
      src={logo.url}
      alt="MIRAVIKA — Luxury Redefined"
      width={size}
      height={size}
      style={{ width: size, height: "auto" }}
      className={cn("select-none object-contain", className)}
    />
  );
}

export function MiravikaWordmark({ subtitle = "Luxury Redefined" }: { subtitle?: string }) {
  return (
    <div className="text-center">
      <p className="font-display text-xl tracking-[0.3em] text-foreground">MIRAVIKA</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.4em] text-gold">{subtitle}</p>
    </div>
  );
}
