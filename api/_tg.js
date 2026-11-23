// Проверка подлинности данных Telegram Mini App (initData).
// 1) BOT_TOKEN задан — классическая проверка HMAC-SHA256 (secret = HMAC("WebAppData", token)).
// 2) Задан только BOT_ID — проверка Ed25519-подписи Telegram (токен бота не нужен).
// Если проверка настроена, initData без подписи отклоняется.
// 3) Ничего не задано — данные принимаются без проверки (verified: false).
import crypto from 'node:crypto';

const TG_PUB = { prod: 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d', test: '40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec' };
const MAX_AGE = 7 * 86400;   // initData старше недели не принимаем

function ed25519Key(hex) {
  // SPKI-обёртка для «сырого» 32-байтового ключа Ed25519
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}
const b64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4), 'base64');

export function parseInitData(raw, env = process.env) {
  if (!raw || typeof raw !== 'string' || raw.length > 8192) return { ok: false, reason: 'empty' };
  const p = new URLSearchParams(raw);
  const hash = p.get('hash'), signature = p.get('signature');
  const pairs = [...p.entries()].filter(([k]) => k !== 'hash' && k !== 'signature').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  let user = null; try { user = JSON.parse(p.get('user') || 'null'); } catch (e) {}
  if (!user || !user.id) return { ok: false, reason: 'nouser' };
  const authDate = +p.get('auth_date') || 0;
  const fresh = Date.now() / 1000 - authDate < MAX_AGE;
  let verified = false, method = 'none';
  const token = env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  if (token && hash) {
    const dcs = [...p.entries()].filter(([k]) => k !== 'hash').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    verified = calc.length === hash.length && crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
    method = 'hmac';
    if (!verified) return { ok: false, reason: 'badhash' };
  } else if (signature && (env.BOT_ID || token)) {
    const botId = String(env.BOT_ID || token.split(':')[0]).trim();
    const dcs = `${botId}:WebAppData\n` + pairs.map(([k, v]) => `${k}=${v}`).join('\n');
    try { verified = crypto.verify(null, Buffer.from(dcs), ed25519Key(env.TG_PUBKEY || (env.TG_TEST_ENV ? TG_PUB.test : TG_PUB.prod)), b64url(signature)); } catch (e) { verified = false; }
    method = 'ed25519';
    if (!verified) return { ok: false, reason: 'badsig' };
  } else if (env.BOT_ID || token) {
    return { ok: false, reason: 'unsigned' };   // проверка настроена — данные без подписи не принимаем
  }
  if (verified && !fresh) return { ok: false, reason: 'expired' };
  return { ok: true, verified, method, user: {
    id: String(user.id), first: String(user.first_name || '').slice(0, 64), last: String(user.last_name || '').slice(0, 64),
    username: user.username ? String(user.username).slice(0, 64) : '', photo: /^https:\/\//.test(user.photo_url || '') ? user.photo_url : '',
    lang: user.language_code || '', premium: !!user.is_premium } };
}
