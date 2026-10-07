import type { ReactNode } from "react";
import { AppLogoMark } from "@/components/ui/AppLogoMark.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <StartupLogoBadge />
      {children}
    </div>
  );
}

/**
 * 初始化与引导共用品牌图标。
 *
 * 标识本身已经是带底色的整枚图标，所以这里只负责尺寸与呼吸效果，
 * 不再自绘深色圆角底与描边。
 */
export function StartupLogoBadge({ animated = true }: { animated?: boolean }) {
  return (
    <AppLogoMark
      className={`size-24 rounded-3xl shadow-xl/20${animated ? " animate-pulse" : ""}`}
    />
  );
}
