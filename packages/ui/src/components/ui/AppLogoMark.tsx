import appMarkUrl from "@/assets/rcode-mark.png";
import { cn } from "@/components/lib/utils.js";

/**
 * 应用标识。
 *
 * 现在是带底色的完整圆角图标（PNG），因此调用方不要再叠加自绘底色或描边：
 * 旧实现是单色字形，需要外部底色衬托；整枚图标再包一层会变成"框中框"。
 */
export function AppLogoMark({ className }: { className?: string }) {
  return (
    <img
      src={appMarkUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("shrink-0 select-none", className)}
    />
  );
}
