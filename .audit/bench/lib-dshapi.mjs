// 共享：dshapi 端点与凭据（不落明文 key）
// 取值顺序：① 环境变量 DSHAPI_API_KEY ② ~/.dsh/.credentials.yaml 的 refs.DSHAPI_API_KEY
// 依据：实测脚本曾被写入明文 key —— 凭据不进源码，从既有凭据文件读。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const BASE = 'https://api.dshapi.icu/v1';

function fromEnv() {
  const k = process.env.DSHAPI_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

function fromCredentials() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const p = join(home, '.credentials.yaml');
  let txt;
  try { txt = readFileSync(p, 'utf8'); } catch { return null; }
  const m = txt.match(/^\s*DSHAPI_API_KEY:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

export const KEY = fromEnv() ?? fromCredentials();

if (!KEY) {
  console.error(
    '缺少 dshapi 凭据。请设置环境变量 DSHAPI_API_KEY，或确认 ' +
    '~/.dsh/.credentials.yaml 含 refs.DSHAPI_API_KEY。'
  );
  process.exit(2);
}

export const MODELS = ['deepseek-v4.1-flash', 'glm-5.3-flash'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
