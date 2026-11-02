// это_нормально · сервер Игротеки (Cloudflare Worker + D1)
// - вебхук Telegram-бота: /start /games /top /bug /stop /notify /setbugs /announce
// - API рекордов для игр: подпись Telegram проверяется на сервере, накрутка не проходит
// Секреты (env): BOT_TOKEN, TG_SECRET. База: env.DB (D1).

const BOT = 'eto_normalno_games_bot';
const SITE = 'https://uragankatrina.github.io/Zmeyka/';
const ORIGINS = ['https://uragankatrina.github.io'];
const GAMES = {
  zmeyka: { title: 'Чайная змейка', unit: 'чаёв', max: 400 },
  tapok: { title: 'Тапок с балкона', unit: 'попаданий', max: 300 },
  kover: { title: 'Сосед улетел', unit: 'метров', max: 20000 },
};
const appLink = (app, param) => `https://t.me/${BOT}/${app}` + (param ? `?startapp=${param}` : '');
const HUB = `https://t.me/${BOT}?startapp`;

// ---------- database ----------
let ready = false;
async function schema(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS users (user_id INTEGER PRIMARY KEY, chat_id INTEGER, name TEXT, notify INTEGER DEFAULT 1, joined INTEGER, last_submit INTEGER DEFAULT 0, bc_sent INTEGER DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS scores (user_id INTEGER, game TEXT, score INTEGER, name TEXT, updated INTEGER, PRIMARY KEY (user_id, game))'),
    db.prepare('CREATE INDEX IF NOT EXISTS scores_top ON scores (game, score DESC)'),
    db.prepare('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)'),
  ]);
  ready = true;
}
const getSetting = async (db, k) => (await db.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first())?.v ?? null;
const setSetting = (db, k, v) => db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v)).run();

// ---------- helpers ----------
const enc = new TextEncoder();
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// Telegram Mini App initData check: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export async function verifyInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || typeof initData !== 'string' || initData.length > 4096) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', botToken);
  const calc = hex(await hmac(secret, check));
  if (calc.length !== hash.length) return null;
  let diff = 0;
  for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff !== 0) return null;
  const age = Math.floor(Date.now() / 1000) - Number(p.get('auth_date') || 0);
  if (!(age >= -60 && age <= maxAgeSec)) return null;
  try { return JSON.parse(p.get('user') || 'null'); } catch { return null; }
}

const shortName = (u) => {
  const n = [u.first_name, u.last_name ? u.last_name[0] + '.' : ''].filter(Boolean).join(' ').trim() || (u.username ? '@' + u.username : 'Игрок');
  return n.replace(/[\u0000-\u001f<>]/g, '').slice(0, 24);
};

function cors(req) {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
const json = (req, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(req) } });

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({ ok: false }));
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---------- API for the games ----------
async function apiScore(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return json(req, { error: 'bad_json' }, 400);
  const user = await verifyInitData(body.initData, env.BOT_TOKEN);
  if (!user || !user.id) return json(req, { error: 'unauthorized' }, 401);
  const g = GAMES[body.game];
  const score = Math.floor(Number(body.score));
  if (!g || !Number.isFinite(score) || score < 0 || score > g.max) return json(req, { error: 'bad_score' }, 400);

  const db = env.DB, now = Date.now(), name = shortName(user);
  const u = await db.prepare('SELECT last_submit FROM users WHERE user_id = ?').bind(user.id).first();
  if (u && now - (u.last_submit || 0) < 3000) return json(req, { error: 'too_fast' }, 429);
  await db.batch([
    db.prepare('INSERT INTO users (user_id, name, joined, last_submit) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, last_submit = excluded.last_submit').bind(user.id, name, now, now),
    db.prepare('INSERT INTO scores (user_id, game, score, name, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, game) DO UPDATE SET score = MAX(score, excluded.score), name = excluded.name, updated = CASE WHEN excluded.score > score THEN excluded.updated ELSE updated END').bind(user.id, body.game, score, name, now),
  ]);
  const me = await db.prepare('SELECT score FROM scores WHERE user_id = ? AND game = ?').bind(user.id, body.game).first();
  const rank = await db.prepare('SELECT COUNT(*) + 1 AS r FROM scores WHERE game = ? AND score > ?').bind(body.game, me.score).first();
  return json(req, { best: me.score, rank: rank.r });
}

async function apiTop(req, env) {
  const body = await req.json().catch(() => ({}));
  const game = body.game;
  if (!GAMES[game]) return json(req, { error: 'bad_game' }, 400);
  const db = env.DB;
  const top = (await db.prepare('SELECT user_id, name, score FROM scores WHERE game = ? ORDER BY score DESC, updated ASC LIMIT 20').bind(game).all()).results || [];
  let me = null;
  const user = body.initData ? await verifyInitData(body.initData, env.BOT_TOKEN) : null;
  if (user) {
    const row = await db.prepare('SELECT score FROM scores WHERE user_id = ? AND game = ?').bind(user.id, game).first();
    if (row) me = { score: row.score, rank: (await db.prepare('SELECT COUNT(*) + 1 AS r FROM scores WHERE game = ? AND score > ?').bind(game, row.score).first()).r };
  }
  const players = (await db.prepare('SELECT COUNT(*) AS n FROM scores WHERE game = ?').bind(game).first()).n;
  return json(req, { top: top.map((r) => ({ name: r.name, score: r.score, me: !!(user && r.user_id === user.id) })), me, players });
}

// ---------- the bot ----------
const gamesKeyboard = (inPrivate) => ({
  inline_keyboard: [
    [inPrivate ? { text: '🎮 Открыть Игротеку', web_app: { url: SITE + 'igroteka/' } } : { text: '🎮 Открыть Игротеку', url: HUB }],
    [{ text: '☕ Змейка', url: appLink('zmeyka') }, { text: '🩴 Тапок', url: appLink('tapok') }, { text: '🧞 Сосед', url: appLink('kover') }],
  ],
});

async function topText(db) {
  const medal = ['🥇', '🥈', '🥉', '4.', '5.'];
  const parts = ['📰 <b>ВЕСТИ ПОДЪЕЗДА</b>\n<i>лучшие игроки на сегодня</i>'];
  for (const [id, g] of Object.entries(GAMES)) {
    const rows = (await db.prepare('SELECT name, score FROM scores WHERE game = ? ORDER BY score DESC, updated ASC LIMIT 5').bind(id).all()).results || [];
    parts.push(`\n<b>${g.title}</b>`);
    if (!rows.length) parts.push('<i>пока никого — будь первым</i>');
    rows.forEach((r, i) => parts.push(`${medal[i]} ${esc(r.name)} — <b>${r.score}</b> ${g.unit}`));
  }
  parts.push('\n<i>Свидетели: все. Побить рекорд: пока никто.</i>');
  return parts.join('\n');
}

async function onUpdate(update, env, ctx) {
  const msg = update.message;
  if (!msg || !msg.text || !msg.from) return;
  const db = env.DB, chat = msg.chat, from = msg.from, priv = chat.type === 'private';
  const m = msg.text.trim().match(/^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
  if (!m) {
    if (priv) await tg(env, 'sendMessage', { chat_id: chat.id, text: 'Я пока умею только в игры ☕ Жми кнопку или /games', reply_markup: gamesKeyboard(true) });
    return;
  }
  const [, cmdRaw, at, argRaw] = m;
  if (at && at.toLowerCase() !== BOT.toLowerCase()) return; // command for another bot
  const cmd = cmdRaw.toLowerCase(), arg = (argRaw || '').trim();

  if (priv) {
    await db.prepare('INSERT INTO users (user_id, chat_id, name, joined) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, name = excluded.name')
      .bind(from.id, chat.id, shortName(from), Date.now()).run();
  }

  switch (cmd) {
    case 'start':
    case 'games': {
      const caption = cmd === 'start'
        ? `<b>Привет${from.first_name ? ', ' + esc(from.first_name) : ''}!</b> Это Игротека «это_нормально» ☕\n\n☕ <b>Чайная змейка</b> — собери чай, пока не остыл\n🩴 <b>Тапок с балкона</b> — верни тишину во двор\n🧞 <b>Сосед улетел</b> — ковёр-самолёт против сплетен\n\nСобирай чашки, покупай скины, вызывай друзей побить твой рекорд.\n\n<i>Пришлю, когда выйдет новая игра. Не надо — /stop</i>`
        : '<b>Во что сыграем?</b>\n5 минут для себя — это нормально ☕';
      const r = await tg(env, 'sendPhoto', { chat_id: chat.id, photo: SITE + 'common/bot-banner.jpg', caption, parse_mode: 'HTML', reply_markup: gamesKeyboard(priv) });
      if (!r.ok) await tg(env, 'sendMessage', { chat_id: chat.id, text: caption, parse_mode: 'HTML', reply_markup: gamesKeyboard(priv) });
      return;
    }
    case 'top':
      await tg(env, 'sendMessage', { chat_id: chat.id, text: await topText(db), parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🎮 Побить рекорд', url: HUB }]] } });
      return;
    case 'stop':
      if (priv) { await db.prepare('UPDATE users SET notify = 0 WHERE user_id = ?').bind(from.id).run(); await tg(env, 'sendMessage', { chat_id: chat.id, text: 'Ок, больше не пишу о новых играх. Вернуть — /notify' }); }
      return;
    case 'notify':
      if (priv) { await db.prepare('UPDATE users SET notify = 1 WHERE user_id = ?').bind(from.id).run(); await tg(env, 'sendMessage', { chat_id: chat.id, text: 'Готово, напишу, когда выйдет новая игра ☕' }); }
      return;
    case 'bug': {
      if (!arg) { await tg(env, 'sendMessage', { chat_id: chat.id, text: 'Напиши одним сообщением: /bug и что сломалось. Например: /bug в тапке пропадают машины' }); return; }
      const bugs = await getSetting(db, 'bugs_chat');
      if (bugs) {
        await tg(env, 'sendMessage', { chat_id: Number(bugs), text: `🐞 Баг от ${esc(shortName(from))}${from.username ? ' (@' + esc(from.username) + ')' : ''}:\n\n${esc(arg.slice(0, 3000))}`, parse_mode: 'HTML' });
      }
      await tg(env, 'sendMessage', { chat_id: chat.id, text: '🐞 Спасибо! Передали — починим. Это нормально, что иногда ломается ☕', reply_to_message_id: msg.message_id });
      return;
    }
    case 'setbugs': {
      // first person to run this in a group becomes the owner; later only the owner can move it
      if (priv) { await tg(env, 'sendMessage', { chat_id: chat.id, text: 'Эту команду нужно отправить в группе, куда присылать баги.' }); return; }
      const owner = await getSetting(db, 'owner');
      if (owner && Number(owner) !== from.id) return;
      const member = await tg(env, 'getChatMember', { chat_id: chat.id, user_id: from.id });
      if (!member.ok || !['creator', 'administrator'].includes(member.result.status)) return;
      if (!owner) await setSetting(db, 'owner', from.id);
      await setSetting(db, 'bugs_chat', chat.id);
      await tg(env, 'sendMessage', { chat_id: chat.id, text: 'Готово: баги из /bug будут приходить сюда.' });
      return;
    }
    case 'announce': {
      const owner = await getSetting(db, 'owner');
      if (!priv || !owner || Number(owner) !== from.id) return;
      if (!arg) { await tg(env, 'sendMessage', { chat_id: chat.id, text: 'Напиши: /announce текст новости. Уйдёт всем, кто не отписался (/stop).' }); return; }
      const id = Date.now();
      await setSetting(db, 'bc_text', arg.slice(0, 3500));
      await setSetting(db, 'bc_id', id);
      const n = (await db.prepare('SELECT COUNT(*) AS n FROM users WHERE notify = 1 AND chat_id IS NOT NULL').first()).n;
      await tg(env, 'sendMessage', { chat_id: chat.id, text: `Рассылка запущена: ${n} получателей. Отправляю порциями, по ~40 в минуту.` });
      ctx.waitUntil(broadcastChunk(env));
      return;
    }
    default:
      if (priv) await tg(env, 'sendMessage', { chat_id: chat.id, text: 'Что я умею:\n/games — все игры\n/top — рекорды игроков\n/bug — сообщить об ошибке\n/stop — не присылать новости' });
  }
}

// sends the current broadcast to the next ~40 people (free plan allows 50 outgoing requests per run)
async function broadcastChunk(env) {
  const db = env.DB;
  await schema(db);
  const text = await getSetting(db, 'bc_text'), id = Number(await getSetting(db, 'bc_id'));
  if (!text || !id) return;
  const rows = (await db.prepare('SELECT user_id, chat_id FROM users WHERE notify = 1 AND chat_id IS NOT NULL AND bc_sent < ? LIMIT 40').bind(id).all()).results || [];
  if (!rows.length) { await setSetting(db, 'bc_text', ''); return; }
  for (const r of rows) {
    const res = await tg(env, 'sendMessage', { chat_id: r.chat_id, text, reply_markup: { inline_keyboard: [[{ text: '🎮 Играть', url: HUB }]] } });
    // blocked the bot → stop writing to them
    if (!res.ok && res.error_code === 403) await db.prepare('UPDATE users SET notify = 0 WHERE user_id = ?').bind(r.user_id).run();
    await db.prepare('UPDATE users SET bc_sent = ? WHERE user_id = ?').bind(id, r.user_id).run();
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    await schema(env.DB);
    try {
      if (req.method === 'POST' && url.pathname === '/tg') {
        if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_SECRET) return new Response('forbidden', { status: 403 });
        const update = await req.json().catch(() => null);
        if (update) ctx.waitUntil(onUpdate(update, env, ctx).catch((e) => console.log('update error', e && e.message)));
        return new Response('ok');
      }
      if (req.method === 'POST' && url.pathname === '/api/score') return await apiScore(req, env);
      if (req.method === 'POST' && url.pathname === '/api/top') return await apiTop(req, env);
      if (url.pathname === '/') return new Response('это_нормально · Игротека работает ☕', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      return new Response('not found', { status: 404 });
    } catch (e) {
      console.log('error', e && e.message);
      return json(req, { error: 'server' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(broadcastChunk(env));
  },
};
