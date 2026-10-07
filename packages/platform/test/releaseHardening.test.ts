/**
 * 发布链路安全测试：
 *   B4 下载 Range 与登记校验（审计#17）、B5 上传原子化（审计#18）、B6 semver 预发布比较（审计#19）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PlatformRuntime } from "../src/adapters/composition.js";
import { createPlatformApp } from "../src/adapters/http/app.js";
import { createLogger } from "../src/adapters/log.js";
import { compareVersions, pickLatestRelease, type ReleaseRecord } from "../src/domain/releases.js";
import { createTestRuntime } from "./helpers.js";

const PASSWORD = "initial-password";
const ADMIN_EMAIL = "admin@example.com";
const DOWNLOAD_VERSION = "3.15.0";
const DOWNLOAD_FILE = "ZCode-3.15.0-win-x64.exe";
/** 故意小于测试上传的文件：证明发布产物上传不受普通 API 请求体上限约束。 */
const SMALL_BODY_LIMIT = 1024;

interface ReleaseHarness {
  readonly runtime: PlatformRuntime;
  readonly releasesDir: string;
  readonly adminToken: string;
  request(path: string, init?: RequestInit): Promise<Response>;
}

async function withReleaseHarness(run: (harness: ReleaseHarness) => Promise<void>): Promise<void> {
  const releasesDir = await mkdtemp(join(tmpdir(), "platform-releases-"));
  const runtime = await createTestRuntime({ releasesDir });
  try {
    await runtime.accounts.createUser({ email: ADMIN_EMAIL, password: PASSWORD, role: "admin" });
    const app = createPlatformApp({
      config: runtime.config,
      logger: createLogger({ scope: "test", level: "error", write: () => {} }),
      accounts: runtime.accounts,
      billing: runtime.billing,
      catalog: runtime.catalog,
      plans: runtime.plans,
      releases: runtime.releases,
      operations: runtime.operations,
      modelPublish: runtime.modelPublish,
      gateway: runtime.gateway,
      providers: runtime.repositories.providers,
      prices: runtime.repositories.prices,
      usage: runtime.repositories.usage,
      now: () => Date.now(),
      newProviderId: runtime.newProviderId,
      maxBodyBytes: SMALL_BODY_LIMIT,
    });
    const login = await runtime.accounts.login({ email: ADMIN_EMAIL, password: PASSWORD });
    await run({
      runtime,
      releasesDir,
      adminToken: login.token,
      request: async (path, init = {}) => await app.request(path, init),
    });
  } finally {
    runtime.dispose();
    await rm(releasesDir, { recursive: true, force: true });
  }
}

function uploadInit(token: string, body: BodyInit): RequestInit {
  return { method: "PUT", body, headers: { authorization: `Bearer ${token}` } };
}

function uploadPath(version: string, fileName: string): string {
  return `/api/admin/releases/${version}/${fileName}?platform=windows-x86_64&channel=stable`;
}

function downloadPath(version: string, fileName: string): string {
  return `/releases/electron/${version}/${encodeURIComponent(fileName)}`;
}

// ---------------------------------------------------------------------------
// B4 下载：Range 与登记校验（审计#17）
// ---------------------------------------------------------------------------

test("已登记产物支持单段 Range：206 + Content-Range（审计#17）", async () => {
  await withReleaseHarness(async ({ request, adminToken }) => {
    const content = "0123456789";
    const uploaded = await request(
      uploadPath(DOWNLOAD_VERSION, DOWNLOAD_FILE),
      uploadInit(adminToken, Buffer.from(content)),
    );
    assert.equal(uploaded.status, 201);

    const full = await request(downloadPath(DOWNLOAD_VERSION, DOWNLOAD_FILE));
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-length"), "10");
    assert.equal(await full.text(), content);

    const middle = await request(downloadPath(DOWNLOAD_VERSION, DOWNLOAD_FILE), {
      headers: { range: "bytes=2-5" },
    });
    assert.equal(middle.status, 206);
    assert.equal(middle.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(middle.headers.get("content-length"), "4");
    assert.equal(await middle.text(), "2345");

    const openEnded = await request(downloadPath(DOWNLOAD_VERSION, DOWNLOAD_FILE), {
      headers: { range: "bytes=7-" },
    });
    assert.equal(openEnded.status, 206);
    assert.equal(openEnded.headers.get("content-range"), "bytes 7-9/10");
    assert.equal(await openEnded.text(), "789");

    const suffix = await request(downloadPath(DOWNLOAD_VERSION, DOWNLOAD_FILE), {
      headers: { range: "bytes=-3" },
    });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), "bytes 7-9/10");
    assert.equal(await suffix.text(), "789");

    // end 超过文件大小按 size-1 截断
    const clamped = await request(downloadPath(DOWNLOAD_VERSION, DOWNLOAD_FILE), {
      headers: { range: "bytes=5-100" },
    });
    assert.equal(clamped.status, 206);
    assert.equal(clamped.headers.get("content-range"), "bytes 5-9/10");
    assert.equal(await clamped.text(), "56789");
  });
});

test("非法或不可满足的 Range 返回 416（审计#17）", async () => {
  await withReleaseHarness(async ({ request, adminToken }) => {
    await request(
      uploadPath(DOWNLOAD_VERSION, DOWNLOAD_FILE),
      uploadInit(adminToken, Buffer.from("0123456789")),
    );
    for (const range of ["bytes=100-200", "bytes=5-2", "bytes=abc", "bytes=-0", "bytes=-"]) {
      const response = await request(downloadPath(DOWNLOAD_VERSION, DOWNLOAD_FILE), {
        headers: { range },
      });
      assert.equal(response.status, 416, `Range: ${range} 应回 416`);
      assert.equal(response.headers.get("content-range"), "bytes */10");
    }
    // 非 bytes 单位与多段 Range 按 RFC 7233 忽略，返回完整内容
    for (const range of ["items=0-1", "bytes=0-1,5-6"]) {
      const response = await request(downloadPath(DOWNLOAD_VERSION, DOWNLOAD_FILE), {
        headers: { range },
      });
      assert.equal(response.status, 200, `Range: ${range} 应被忽略`);
      assert.equal(await response.text(), "0123456789");
    }
  });
});

test("未登记的文件不可下载，路径穿越被挡（审计#17）", async () => {
  await withReleaseHarness(async ({ request, releasesDir, adminToken }) => {
    // 磁盘上有文件但从未登记：必须 404
    const directory = join(releasesDir, "9.9.9");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "unregistered.exe"), "not-registered");

    const unregistered = await request(downloadPath("9.9.9", "unregistered.exe"));
    assert.equal(unregistered.status, 404);

    // 路径穿越：版本或文件名里带分隔符/上跳一律 404
    for (const path of [
      "/releases/electron/9.9.9/..%2F..%2Fpackage.json",
      "/releases/electron/..%2F9.9.9/unregistered.exe",
      "/releases/electron/9.9.9/%2e%2e%2f%2e%2e%2fpackage.json",
    ]) {
      const traversal = await request(path);
      assert.notEqual(traversal.status, 200, `${path} 不应可读`);
      assert.equal(traversal.status, 404, `${path} 应回 404`);
    }

    // 已登记但文件被删除：也是 404
    await request(uploadPath("1.0.0", "gone.exe"), uploadInit(adminToken, Buffer.from("payload")));
    await rm(join(releasesDir, "1.0.0", "gone.exe"), { force: true });
    const missing = await request(downloadPath("1.0.0", "gone.exe"));
    assert.equal(missing.status, 404);
  });
});

// ---------------------------------------------------------------------------
// B5 上传原子化（审计#18）
// ---------------------------------------------------------------------------

test("上传先写临时文件再落位：不留临时文件，重复上传原子替换（审计#18）", async () => {
  await withReleaseHarness(async ({ request, releasesDir, adminToken }) => {
    const version = "4.0.0";
    const fileName = "installer.exe";
    const directory = join(releasesDir, version);
    // 超过普通 API 上限（1024）的体积：发布产物上传必须不受该上限约束
    const firstContent = Buffer.alloc(4096, 0x61);

    const first = await request(
      uploadPath(version, fileName),
      uploadInit(adminToken, firstContent),
    );
    assert.equal(first.status, 201);
    assert.deepEqual(await readdir(directory), [fileName], "成功后不应留下 .tmp-* 临时文件");
    assert.deepEqual(await readFile(join(directory, fileName)), firstContent);

    // 同名再次上传（内容不同）：Windows 下 rename 覆盖会失败，必须被原子替换
    const secondContent = Buffer.alloc(5000, 0x62);
    const second = await request(
      uploadPath(version, fileName),
      uploadInit(adminToken, secondContent),
    );
    assert.equal(second.status, 201);
    assert.deepEqual(await readdir(directory), [fileName]);
    assert.deepEqual(await readFile(join(directory, fileName)), secondContent);

    const downloaded = await request(downloadPath(version, fileName));
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-length"), String(secondContent.length));
  });
});

test("上传失败不留下半文件，也不破坏已登记的旧文件（审计#18）", async () => {
  await withReleaseHarness(async ({ request, releasesDir, adminToken }) => {
    const version = "5.0.0";
    const fileName = "installer.exe";
    const directory = join(releasesDir, version);

    // 第一次上传就是空内容：失败，且目录里不能留下任何文件（半截或临时）
    const empty = await request(uploadPath(version, fileName), uploadInit(adminToken, ""));
    assert.equal(empty.status, 400);
    assert.deepEqual(await readdir(directory), [], "失败上传不应留下临时文件");

    // 成功上传一份旧产物后，任何失败上传都不能破坏它
    const good = Buffer.from("good-installer-bytes");
    const uploaded = await request(uploadPath(version, fileName), uploadInit(adminToken, good));
    assert.equal(uploaded.status, 201);

    const failed = await request(uploadPath(version, fileName), uploadInit(adminToken, ""));
    assert.equal(failed.status, 400);
    assert.deepEqual(await readdir(directory), [fileName], "失败后只应剩已登记的旧文件");
    assert.deepEqual(await readFile(join(directory, fileName)), good);

    // 旧文件仍可下载
    const downloaded = await request(downloadPath(version, fileName));
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), good.toString());
  });
});

test("上传的版本号与文件名不得含路径分隔符（审计#18）", async () => {
  await withReleaseHarness(async ({ request, adminToken }) => {
    const traversal = await request(
      "/api/admin/releases/..%2F..%2Fetc/passwd?platform=windows-x86_64&channel=stable",
      uploadInit(adminToken, Buffer.from("x")),
    );
    assert.notEqual(traversal.status, 201);
    const badName = await request(
      "/api/admin/releases/1.0.0/..%2Fevil.exe?platform=windows-x86_64&channel=stable",
      uploadInit(adminToken, Buffer.from("x")),
    );
    assert.notEqual(badName.status, 201);
  });
});

// ---------------------------------------------------------------------------
// B6 semver 预发布比较（审计#19）
// ---------------------------------------------------------------------------

test("semver 预发布优先级（审计#19）", () => {
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta"), 1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0-rc.2"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.equal(compareVersions("1.0.0-alpha.beta", "1.0.0-beta"), -1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1);
  assert.equal(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
  // 纯数字标识恒低于字母数字标识
  assert.equal(compareVersions("1.0.0-2", "1.0.0-alpha"), -1);
  // 构建元数据不参与比较；前导 v 忽略
  assert.equal(compareVersions("1.0.0+build.9", "1.0.0+build.1"), 0);
  assert.equal(compareVersions("v2.0.0-rc.1", "2.0.0-rc.1"), 0);
  // 预发布低于更低的正式版
  assert.equal(compareVersions("2.0.0-rc.1", "1.9.9"), 1);
  // 数值比较而非字典序
  assert.equal(compareVersions("3.15.0", "3.9.0"), 1);
  assert.equal(compareVersions("1.2.10", "1.2.9"), 1);
});

test("pickLatestRelease：正式版胜过同号预发布版，最高版本胜出（审计#19）", () => {
  const make = (version: string): ReleaseRecord => ({
    id: `rel_${version}`,
    version,
    channel: "stable",
    platform: "windows-x86_64",
    fileName: `ZCode-${version}.exe`,
    sha512: "",
    sizeBytes: null,
    releaseNotes: null,
    createdAt: 0,
  });

  assert.equal(pickLatestRelease([]), null);
  assert.equal(pickLatestRelease([make("1.0.0-rc.2"), make("1.0.0")])?.version, "1.0.0");
  assert.equal(pickLatestRelease([make("1.0.0"), make("1.0.0-rc.2")])?.version, "1.0.0");
  assert.equal(pickLatestRelease([make("1.0.0-beta"), make("1.0.0-rc.1")])?.version, "1.0.0-rc.1");
  assert.equal(
    pickLatestRelease([make("3.9.0"), make("3.15.0"), make("3.10.0-rc.1")])?.version,
    "3.15.0",
  );
});
