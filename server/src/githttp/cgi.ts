/**
 * Git Smart HTTP CGI 层的纯函数面（S3-T2；api.md §8.4；架构 §3.2）：
 *
 * - parseGitSmartRequest：白名单化的端点解析——Smart HTTP 只暴露四个端点组合
 *   （GET info/refs × 两 service、POST 两 pack 端点），哑协议与一切其余路径
 *   一律 null（404，不进入 CGI 转发，也不提供未授权对象读取）。
 * - parseBasicAuth：HTTP Basic 载体解析（identity §3.1：用户名任意，token
 *   作口令是唯一凭据——username 不参与任何判定）。
 * - buildRemoteUser/parseRemoteUser：REMOTE_USER 透传格式（api.md §8.4「认证
 *   员工标识（+ 凭据 id）」）：`<employeeId>:<credentialId>`。pre-receive hook
 *   据此取得认证主体（审计主体不信任 commit author，架构 §4.4）。
 * - buildCgiEnv：git http-backend CGI 环境组装（GIT_PROJECT_ROOT/PATH_INFO/
 *   REMOTE_USER/CONTENT_TYPE/LENGTH/QUERY_STRING…）。仓库路径只经 DB 稳定 ID
 *   映射进 PATH_INFO，不含 slug（架构 §3.2）。
 */

export type GitService = 'git-upload-pack' | 'git-receive-pack';

export interface GitSmartRequest {
  readonly slug: string;
  /** URL 中 `.git` 之后的端点后缀（如 `/info/refs`），进 PATH_INFO */
  readonly suffix: string;
  readonly service: GitService;
  /** refs 发现与 pack 双向同判定：receive-pack = write，upload-pack = read */
  readonly action: 'read' | 'write';
}

/** api.md §5 slug 字符集：小写字母/数字/`-`，长度 1–64 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `/git/<slug>[.git]<suffix>`；slug 段不含 `/`。suffix 形态交由下方端点白名单
 *  收口（`/info/refs`、两 pack 端点之外——含一切 `..` 穿越与哑协议路径——一律 null）。 */
const GIT_URL_RE = /^\/git\/([^/]+?)(?:\.git)?(\/.*)?$/;

export function parseGitSmartRequest(
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
): GitSmartRequest | null {
  const m = GIT_URL_RE.exec(pathname);
  if (m === null) return null;
  const slug = m[1]!;
  const suffix = m[2] ?? '';
  if (!SLUG_RE.test(slug)) return null;
  if (method === 'GET' && suffix === '/info/refs') {
    const service = searchParams.get('service');
    if (service === 'git-upload-pack') return { slug, suffix, service, action: 'read' };
    if (service === 'git-receive-pack') return { slug, suffix, service, action: 'write' };
    return null; // 无 service（哑协议形态）或未知 service
  }
  if (method === 'POST' && (suffix === '/git-upload-pack' || suffix === '/git-receive-pack')) {
    const service = suffix.slice(1) as GitService;
    return { slug, suffix, service, action: service === 'git-receive-pack' ? 'write' : 'read' };
  }
  return null;
}

/** HTTP Basic 解析：`user:password`（首个冒号切分——token 不含冒号，用户名任意）。
 *  非 Basic scheme / 畸形 base64 / 无冒号 → null（→ 401，不回退其他载体）。 */
export function parseBasicAuth(header: string | undefined): { username: string; password: string } | null {
  if (header === undefined) return null;
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (m === null) return null;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i === -1) return null;
  return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

export function buildRemoteUser(employeeId: number, credentialId: number): string {
  return `${employeeId}:${credentialId}`;
}

export function parseRemoteUser(remoteUser: string): { employeeId: number; credentialId: number } | null {
  const m = /^(\d+):(\d+)$/.exec(remoteUser);
  if (m === null) return null;
  const employeeId = Number(m[1]);
  const credentialId = Number(m[2]);
  if (!Number.isSafeInteger(employeeId) || !Number.isSafeInteger(credentialId)) return null;
  return { employeeId, credentialId };
}

export interface CgiEnvInput {
  readonly method: string;
  readonly pathInfo: string;
  readonly queryString: string;
  readonly projectRoot: string;
  readonly remoteUser: string;
  readonly remoteAddr?: string;
  readonly contentType?: string;
  readonly contentLength?: string;
  readonly contentEncoding?: string;
  readonly acceptEncoding?: string;
  /** Git-Protocol 请求头（如 `version=2`）→ HTTP_GIT_PROTOCOL：http-backend 据此
   *  协商协议 v2——空库的 unborn HEAD 目标（symref=HEAD:refs/heads/main）只在
   *  v2 ls-refs 出现，缺失则空克隆落回客户端本地默认分支。 */
  readonly gitProtocol?: string;
  /** 透传给 receive-pack hook 的自定义变量（NOTEGIT_DB/NOTEGIT_VAULT_*）；值为 undefined 的键跳过 */
  readonly extra?: Readonly<Record<string, string | undefined>>;
}

/**
 * CGI 环境组装（git http-backend 契约，https://git-scm.com/docs/git-http-backend）：
 * 继承 process.env（PATH 等）后逐项覆盖。GIT_HTTP_EXPORT_ALL=1：导出检查由本层
 * 的鉴权替代（架构 §3.2：接入层必须鉴权，不公开未授权对象读取）。CONTENT_LENGTH
 * 仅在客户端提供时注入（chunked 推送无该头——http-backend 读到 stdin EOF）。
 */
export function buildCgiEnv(input: CgiEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['GATEWAY_INTERFACE'] = 'CGI/1.1';
  env['SERVER_PROTOCOL'] = 'HTTP/1.1';
  env['REQUEST_METHOD'] = input.method;
  env['QUERY_STRING'] = input.queryString;
  env['PATH_INFO'] = input.pathInfo;
  env['GIT_PROJECT_ROOT'] = input.projectRoot;
  env['GIT_HTTP_EXPORT_ALL'] = '1';
  env['REMOTE_USER'] = input.remoteUser;
  if (input.remoteAddr !== undefined) env['REMOTE_ADDR'] = input.remoteAddr;
  if (input.contentType !== undefined) env['CONTENT_TYPE'] = input.contentType;
  if (input.contentLength !== undefined) env['CONTENT_LENGTH'] = input.contentLength;
  if (input.contentEncoding !== undefined) env['HTTP_CONTENT_ENCODING'] = input.contentEncoding;
  if (input.acceptEncoding !== undefined) env['HTTP_ACCEPT_ENCODING'] = input.acceptEncoding;
  if (input.gitProtocol !== undefined) env['HTTP_GIT_PROTOCOL'] = input.gitProtocol;
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
