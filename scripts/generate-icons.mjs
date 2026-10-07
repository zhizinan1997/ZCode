/**
 * 从仓库根目录的 logo.png 生成全部应用图标资源。
 *
 * 用法：
 *   node scripts/generate-icons.mjs            # 生成并覆盖现有图标
 *   node scripts/generate-icons.mjs --check     # 只报告会写哪些文件，不写入
 *
 * 处理步骤：
 *   1. 按 alpha 通道裁剪掉四周多余的透明边距，再回补少量留白，保证图标不贴边；
 *   2. 用逐级减半的缩放生成各尺寸（一次从 1254 缩到 16 会糊）；
 *   3. 同时输出 PNG 尺寸阶梯、Windows .ico（内嵌 PNG 条目）与 macOS .icns。
 *
 * .ico 走内嵌 PNG：Vista 以后都支持，且比 BMP 条目小得多。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Icns, IcnsImage } from "@fiahfy/icns";
import { Jimp } from "jimp";
import { PNG } from "pngjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(repoRoot, "logo.png");
const checkOnly = process.argv.includes("--check");

/** PNG 尺寸阶梯：desktop/build/icons 与 public/logo/icons 用同一套。 */
const LADDER = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
/** .ico 内含尺寸，与仓库原有设置一致。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/**
 * .icns 需要的 OSType。除基础尺寸外还要带 @2x 变体，
 * 否则 Retina 下系统会拿小图放大，图标发虚。
 */
const ICNS_TYPES = [
  { size: 16, type: "icp4" },
  { size: 32, type: "icp5" },
  { size: 64, type: "icp6" },
  { size: 128, type: "ic07" },
  { size: 256, type: "ic08" },
  { size: 512, type: "ic09" },
  { size: 1024, type: "ic10" },
  { size: 32, type: "ic11" },
  { size: 64, type: "ic12" },
  { size: 256, type: "ic13" },
  { size: 512, type: "ic14" },
];

/** 裁剪后保留的留白比例（相对内容边长）。 */
const CONTENT_MARGIN_RATIO = 0.04;

const written = [];
function emit(path, data) {
  written.push(path);
  if (checkOnly) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** 计算非透明像素的包围盒；全透明时返回 null。 */
function readAlphaBounds(png) {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const alpha = png.data[(png.width * y + x) * 4 + 3];
      if (alpha > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/** 逐级减半再缩到目标尺寸，避免大比例缩放的锯齿与细节丢失。 */
async function resizeTo(image, size) {
  let current = image;
  while (current.width / 2 > size && current.width / 2 >= 32) {
    const next = Math.max(size, Math.floor(current.width / 2));
    current = current.clone().resize({ w: next, h: next });
  }
  return current.clone().resize({ w: size, h: size });
}

/** ICO 容器：目录项 + 内嵌 PNG 数据。 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((entry, index) => {
    const base = index * 16;
    // 256 及以上在 ICO 里用 0 表示
    const dimension = entry.size >= 256 ? 0 : entry.size;
    directory.writeUInt8(dimension, base);
    directory.writeUInt8(dimension, base + 1);
    directory.writeUInt8(0, base + 2);
    directory.writeUInt8(0, base + 3);
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

function buildIcns(pngBySize) {
  const icns = new Icns();
  for (const spec of ICNS_TYPES) {
    const png = pngBySize.get(spec.size);
    if (!png) continue;
    icns.append(IcnsImage.fromPNG(png, spec.type));
  }
  return icns.data;
}

async function main() {
  const source = PNG.sync.read(readFileSync(SOURCE));
  const bounds = readAlphaBounds(source);
  if (!bounds) {
    throw new Error("logo.png 全透明，没有可用的图形内容");
  }

  const contentWidth = bounds.maxX - bounds.minX + 1;
  const contentHeight = bounds.maxY - bounds.minY + 1;
  const contentSize = Math.max(contentWidth, contentHeight);
  const margin = Math.round(contentSize * CONTENT_MARGIN_RATIO);
  // 以内容中心为基准取正方形，回补留白，保证图标居中且不贴边。
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const side = Math.min(contentSize + margin * 2, Math.min(source.width, source.height));
  const cropX = Math.max(0, Math.round(centerX - side / 2));
  const cropY = Math.max(0, Math.round(centerY - side / 2));
  const cropSize = Math.min(side, source.width - cropX, source.height - cropY);

  const base = await Jimp.read(SOURCE);
  base.crop({ x: cropX, y: cropY, w: cropSize, h: cropSize });

  const pngBySize = new Map();
  for (const size of LADDER) {
    const resized = await resizeTo(base, size);
    pngBySize.set(size, await resized.getBuffer("image/png"));
  }

  // PNG 尺寸阶梯：桌面构建与站点 logo 目录保持同一套
  for (const size of LADDER) {
    const png = pngBySize.get(size);
    emit(resolve(repoRoot, "packages/desktop/build/icons", `${size}x${size}.png`), png);
    emit(resolve(repoRoot, "public/logo/icons", `${size}x${size}.png`), png);
  }

  // electron-builder 直接引用的 1024 主图
  for (const name of ["icon.png", "icon_windows.png", "icon_installer.png"]) {
    emit(resolve(repoRoot, "packages/desktop/build", name), pngBySize.get(1024));
  }

  const ico = buildIco(
    ICO_SIZES.map((size) => ({ size, png: pngBySize.get(size) })),
  );
  emit(resolve(repoRoot, "packages/desktop/build/icon.ico"), ico);
  emit(resolve(repoRoot, "packages/desktop/build/icon_installer.ico"), ico);

  const icns = buildIcns(pngBySize);
  emit(resolve(repoRoot, "packages/desktop/build/icon.icns"), icns);
  emit(resolve(repoRoot, "packages/desktop/build/icon_installer.icns"), icns);
  emit(resolve(repoRoot, "public/logo/icons/icon.icns"), icns);

  // 以下三处是之前遗漏的品牌资产：设置页更新对话框、浏览器 favicon、React 组件使用的应用标识。
  emit(resolve(repoRoot, "public/icon_512@2x.png"), pngBySize.get(1024));
  emit(resolve(repoRoot, "packages/ui/src/assets/rcode-mark.png"), pngBySize.get(512));
  emit(
    resolve(repoRoot, "packages/web/public/favicon.ico"),
    buildIco([16, 32, 48].map((size) => ({ size, png: pngBySize.get(size) }))),
  );

  console.log(
    JSON.stringify(
      {
        source: `${source.width}x${source.height}`,
        contentBounds: bounds,
        croppedTo: `${cropSize}x${cropSize}`,
        sizes: LADDER,
        files: written.length,
        mode: checkOnly ? "check" : "write",
      },
      null,
      2,
    ),
  );
  if (checkOnly) {
    for (const path of written) {
      console.log("  将写入 " + path.replace(repoRoot, "."));
    }
  }
}

await main();
