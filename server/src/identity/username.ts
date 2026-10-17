/**
 * username 显式形态校验（identity-credentials.md §2，S37 补记）。
 *
 * 两种合法形态：
 * - 裸名（存量开源用户）：`^[a-z0-9][a-z0-9._-]{0,62}$`
 * - 带域名（dshent 平台委托映射 `m<id>@<workspace-slug>`）：`^[a-z0-9][a-z0-9._-]{0,20}@[a-z0-9][a-z0-9-]{0,39}$`
 *
 * 校验只在此处单源；邀请创建与 bootstrap 共用。
 */

const BARE_USERNAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const DOMAINED_USERNAME = /^[a-z0-9][a-z0-9._-]{0,20}@[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidUsername(username: string): boolean {
  return BARE_USERNAME.test(username) || DOMAINED_USERNAME.test(username);
}
