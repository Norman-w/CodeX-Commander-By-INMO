const OPENAI_KEY = /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}/g;
const GITHUB_TOKEN = /(?:github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})/g;
const AWS_KEY = /AKIA[0-9A-Z]{16}/g;
const UNIX_HOME = /(?:\/Users|\/home)\/[^/\s]+/g;
const WINDOWS_HOME = /[A-Za-z]:\\Users\\[^\\\s]+/gi;

export function redactSecrets(value: string): string {
  return value
    .replace(OPENAI_KEY, "[已隐藏密钥]")
    .replace(GITHUB_TOKEN, "[已隐藏令牌]")
    .replace(AWS_KEY, "[已隐藏访问密钥]");
}

export function sanitizeForVisor(value: string, maxLength: number, sensitiveRoots: readonly string[] = []): string {
  let result = redactSecrets(value);
  for (const root of [...sensitiveRoots].filter(Boolean).sort((left, right) => right.length - left.length)) {
    result = result.split(root).join("[工作目录]");
  }
  return result
    .replace(UNIX_HOME, "[本机目录]")
    .replace(WINDOWS_HOME, "[本机目录]")
    .slice(0, maxLength);
}
