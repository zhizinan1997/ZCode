/**
 * 密码强度规则（纯函数）。
 *
 * 实际的 scrypt 派生在 adapters/crypto 里：domain 层不得依赖 node: 内置模块，
 * 而随机数与哈希都属于 IO/平台能力，必须由外部注入。
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

/** 管理员建号与用户改密共用。合法返回 null，非法返回可直接展示的原因。 */
export function validatePasswordStrength(plain: string): string | null {
  if (plain.length < PASSWORD_MIN_LENGTH) {
    return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
  }
  if (plain.length > PASSWORD_MAX_LENGTH) {
    return `密码最多 ${PASSWORD_MAX_LENGTH} 位`;
  }
  return null;
}
