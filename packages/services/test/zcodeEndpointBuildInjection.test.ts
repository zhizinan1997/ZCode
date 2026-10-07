/**
 * 安装包的端点解析：调用方 env vs 构建期注入（specs/platform/brand-boundary.md 验收 2）。
 *
 * 回归点：desktop 主进程里有模块在**顶层**用 `process.env` 调 `buildRuntimeZCodeApiUrl`
 * （`packages/services/src/providers/api/apiEndpoints.ts`、`model-provider/zaiStartPlanBilling.ts`
 * 及各 main/host 服务）。安装包既没有 `.env`，进程环境里也没有 `ZCODE_BASE_URL`
 * （安装器与快捷方式都不写该变量），地址只存在于构建期注入的 `__ZCODE_ENDPOINT_ENV__`。
 * 只要解析只看传入的 env，production 产物就会在模块求值阶段抛「商业版未配置服务地址」，
 * 应用启动即崩（v0.0.3 的实际故障）。
 *
 * 这些语义只在编译期 define 下成立，普通 tsx 运行环境里两个常量都是 undefined，
 * 因此这里用 esbuild 复刻 desktop tsup 的 define 组合，把 shared 端点模块打成真实产物，
 * 再在进程环境清干净的子进程里执行。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const runNode = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const sharedEndpointSourcePath = resolve(testDir, "../../shared/src/zcodeEndpoint.ts");
const injectedOrigin = "https://platform.example.test";
const explicitOrigin = "https://explicit.example.test";
const legacyVendorOrigin = "https://zcode.z.ai";
const missingOriginError = "商业版未配置服务地址";

// specifier 交给插件解析，避免在 fixture 里拼 Windows 绝对路径。
const fixturePlugin = {
  name: "zcode-endpoint-fixture",
  setup(buildApi: {
    onResolve(
      options: { filter: RegExp },
      callback: () => { path: string },
    ): void;
  }) {
    buildApi.onResolve({ filter: /^zcode-endpoint-fixture$/ }, () => ({
      path: sharedEndpointSourcePath,
    }));
  },
};

const defaultFixtureSource = `
import {
  buildRuntimeZCodeApiUrl,
  resolveRuntimeZCodeEndpointOrigin,
} from "zcode-endpoint-fixture";

const report = {
  fromProcessEnv: null,
  fromProcessEnvError: null,
  emptyEnvOrigin: null,
  emptyEnvError: null,
};

try {
  report.fromProcessEnv = buildRuntimeZCodeApiUrl(process.env, "/api/v1/client/scenes");
} catch (error) {
  report.fromProcessEnvError = error.message;
}

try {
  report.emptyEnvOrigin = resolveRuntimeZCodeEndpointOrigin({});
} catch (error) {
  report.emptyEnvError = error.message;
}

process.stdout.write("REPORT:" + JSON.stringify(report));
`;

interface FixtureReport {
  fromProcessEnv: string | null;
  fromProcessEnvError: string | null;
  emptyEnvOrigin: string | null;
  emptyEnvError: string | null;
}

async function runFixture(
  defines: Record<string, string>,
  source = defaultFixtureSource,
): Promise<Record<string, string | null>> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "zcode-endpoint-fixture-"));
  const outfile = join(fixtureDir, "fixture.mjs");
  await build({
    stdin: { contents: source, loader: "js", resolveDir: testDir },
    plugins: [fixturePlugin],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    define: defines,
    outfile,
  });

  // 安装包运行时的进程环境里没有这些变量；本机 shell 通常带着 ZCODE_BASE_URL，
  // 不清干净就测不出真实产物的行为。
  const childEnv = { ...process.env };
  for (const key of ["ZCODE_BASE_URL", "ZCODE_ENDPOINT_ORIGIN", "ZCODE_ENV"]) {
    delete childEnv[key];
  }

  const { stdout } = await runNode(process.execPath, [outfile], { env: childEnv });
  const reportIndex = stdout.indexOf("REPORT:");
  assert.notEqual(reportIndex, -1, `子进程未输出报告: ${stdout}`);
  return JSON.parse(stdout.slice(reportIndex + "REPORT:".length)) as Record<string, string | null>;
}

const productionDefines = {
  __ZCODE_PRODUCT_FLAVOR__: JSON.stringify("production"),
  __ZCODE_ENV__: JSON.stringify("production"),
};

test("production 安装包：进程环境无地址时回退构建期注入值", async () => {
  const report = (await runFixture({
    ...productionDefines,
    __ZCODE_ENDPOINT_ENV__: JSON.stringify({ ZCODE_BASE_URL: injectedOrigin }),
  })) as unknown as FixtureReport;

  assert.equal(report.fromProcessEnvError, null);
  assert.equal(report.fromProcessEnv, `${injectedOrigin}/api/v1/client/scenes`);
  assert.equal(report.emptyEnvError, null);
  assert.equal(report.emptyEnvOrigin, injectedOrigin);
});

test("production 安装包：没有构建期注入时仍然 fail fast，不回退厂商域名", async () => {
  const report = (await runFixture({
    ...productionDefines,
    __ZCODE_ENDPOINT_ENV__: JSON.stringify({}),
  })) as unknown as FixtureReport;

  assert.match(report.fromProcessEnvError ?? "", new RegExp(missingOriginError));
  assert.match(report.emptyEnvError ?? "", new RegExp(missingOriginError));
  assert.equal(report.emptyEnvOrigin, null);
});

test("preview/开发 flavor：没有构建期注入时保持厂商兼容回退", async () => {
  const report = (await runFixture({
    __ZCODE_PRODUCT_FLAVOR__: JSON.stringify("preview"),
    __ZCODE_ENV__: JSON.stringify("test"),
    __ZCODE_ENDPOINT_ENV__: JSON.stringify({}),
  })) as unknown as FixtureReport;

  assert.equal(report.emptyEnvError, null);
  assert.equal(report.emptyEnvOrigin, legacyVendorOrigin);
});

test("显式 env 覆盖构建期注入值", async () => {
  const report = await runFixture(
    {
      ...productionDefines,
      __ZCODE_ENDPOINT_ENV__: JSON.stringify({ ZCODE_BASE_URL: injectedOrigin }),
    },
    `
import { resolveRuntimeZCodeEndpointOrigin } from "zcode-endpoint-fixture";

process.stdout.write(
  "REPORT:" +
    JSON.stringify({
      override: resolveRuntimeZCodeEndpointOrigin({
        ZCODE_BASE_URL: ${JSON.stringify(explicitOrigin)},
      }),
    }),
);
`,
  );

  assert.equal(report.override, explicitOrigin);
});
