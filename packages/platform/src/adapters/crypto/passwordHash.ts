/**
 * 密码哈希实现（scrypt）。属于平台能力，只能放在 adapters 层。
 *
 * 存储格式：scrypt$N$r$p$salt(base64)$hash(base64)
 * 参数随记录一起保存，将来调整强度时旧记录仍可校验。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { validatePasswordStrength } from "../../domain/passwordPolicy.js";

const ALGORITHM_TAG = "scrypt";
const DEFAULT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function deriveKey(
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
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
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
