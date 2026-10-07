/**
 * 密码哈希实现（scrypt 写入 + 历史 bcrypt 校验）。属于平台能力，只能放在 adapters 层。
 *
 * scrypt 存储格式：scrypt$N$r$p$salt(base64)$hash(base64)
 * 参数随记录一起保存，将来调整强度时旧记录仍可校验。
 *
 * 迁移过来的历史用户数据里 password_hash 是 bcrypt 记录（`$2a$`/`$2b$`/`$2y$` 开头的
 * 60 字符串）。平台只校验、不再生成 bcrypt：校验通过后由登录流程改写成 scrypt，
 * 见 app/accountService.ts 的无感升级。细节见 specs/platform/account.md。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { validatePasswordStrength } from "../../domain/passwordPolicy.js";

const ALGORITHM_TAG = "scrypt";
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * 接受的历史 bcrypt 记录：`$2a$`/`$2b$`/`$2y$` 加两位 cost 加 53 字符 base64。
 *
 * 三个 revision 对 ASCII 密码等价（2b 修掉 8 位字符的符号扩展问题，2y 是 PHP
 * crypt_blowfish 修复后的标记）。其余变体（尤其是 2x，那是同一个缺陷的未修复版）
 * 一律不接受：这类输入交给 bcryptjs 会抛错，而本模块的约定是"记录损坏即校验失败"。
 *
 * cost 上限写死在 16：bcrypt 的计算量是 2^cost，而这个值来自存储记录而不是调用方，
 * 不设上限时一条损坏记录（如 `$2b$31$`）就能让登录请求占住进程数天。纯 JS 实现下
 * cost 16 已需约 6.5 秒，超过它的记录不可能来自任何可用的历史系统，按损坏记录处理。
 */
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$(?:0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$/;

/** 历史 bcrypt 记录：需要升级为 scrypt，登录流程据此决定是否重写哈希。 */
export function needsPasswordRehash(stored: string): boolean {
  return BCRYPT_HASH_PATTERN.test(stored);
}

async function deriveKey(
  plain: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(plain, salt, KEY_LENGTH, params, (error, derived) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derived);
    });
  });
}

/**
 * bcrypt 校验。bcryptjs 对无法解析的记录会抛错（例如未知 revision），
 * 这里收敛为 false，与 scrypt 分支"损坏记录表现为登录失败"的语义保持一致。
 *
 * bcrypt 只取前 72 字节是格式固有语义，历史记录就是按截断后的密码存的，
 * 因此这里不做补偿，交由库按同一规则处理。
 */
async function verifyBcrypt(plain: string, stored: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, stored);
  } catch {
    return false;
  }
}

export async function hashPassword(plain: string): Promise<string> {
  const strengthError = validatePasswordStrength(plain);
  if (strengthError) {
    throw new RangeError(strengthError);
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await deriveKey(plain, salt, DEFAULT_PARAMS);
  return [
    ALGORITHM_TAG,
    DEFAULT_PARAMS.N,
    DEFAULT_PARAMS.r,
    DEFAULT_PARAMS.p,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * 校验密码。存储格式不可解析时返回 false 而不是抛错：
 * 损坏的凭据记录应当表现为登录失败，不能让异常把失败原因暴露出去。
 *
 * 按记录格式分派：历史 bcrypt 记录走 bcrypt，其余按 scrypt 解析。
 * 因此 bcrypt 分支的耗时由记录自带的 cost 决定，与假哈希的 scrypt 不同——
 * 这是已知的枚举防护残余差异，见 specs/platform/account.md。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (needsPasswordRehash(stored)) {
    return await verifyBcrypt(plain, stored);
  }
  const parts = stored.split("$");
  if (parts.length !== 6) {
    return false;
  }
  const [tag, rawN, rawR, rawP, rawSalt, rawHash] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (tag !== ALGORITHM_TAG) {
    return false;
  }
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }
  const salt = Buffer.from(rawSalt, "base64");
  const expected = Buffer.from(rawHash, "base64");
  if (salt.length === 0 || expected.length !== KEY_LENGTH) {
    return false;
  }
  const derived = await deriveKey(plain, salt, { N, r, p });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
