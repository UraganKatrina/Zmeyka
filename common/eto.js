/* это_нормально · общий движок игр
   Кошелёк чашек, задание дня, достижения, скины, рекорды, вызов друга.
   Хранение: localStorage + Telegram CloudStorage (берём максимум). */
(function () {
  const KEY = 'eto_v1';
  const BOT = 'eto_normalno_games_bot';
  const SITE = location.origin + location.pathname.replace(/((igroteka|tapok|kover|classic)\/)?(index\.html)?$/, '');
  const tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== undefined ? window.Telegram.WebApp : null;
  const inTG = !!(tg && tg.initData);

  const GAMES = {
    zmeyka: { title: 'Чайная змейка', unit: 'чаёв', app: 'zmeyka', path: '', verb: 'собрал(а)' },
    tapok: { title: 'Тапок с балкона', unit: 'попаданий', app: 'tapok', path: 'tapok/', verb: 'сделал(а)' },
    kover: { title: 'Сосед улетел', unit: 'метров', app: 'kover', path: 'kover/', verb: 'пролетел(а)' },
  };

  // ---------- state ----------
  const blank = () => ({ cups: 0, best: {}, plays: {}, total: {}, quest: null, ach: [], skins: { owned: ['snake.classic', 'slipper.classic', 'carpet.red'], on: { snake: 'classic', slipper: 'classic', carpet: 'red' } }, challenges: [] });
  let S = blank();
  try { const raw = localStorage.getItem(KEY); if (raw) S = Object.assign(blank(), JSON.parse(raw)); } catch (e) {}
  // migrate old per-game bests
  try {
    const old = { zmeyka: 'tea_snake_best', tapok: 'tapok_best', kover: 'kover_best' };
    for (const g in old) { const v = +localStorage.getItem(old[g]) || 0; if (v > (S.best[g] || 0)) S.best[g] = v; }
  } catch (e) {}

  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
    try { inTG && tg.CloudStorage && tg.CloudStorage.setItem(KEY, JSON.stringify(S).slice(0, 4000)); } catch (e) {}
  };
  // merge cloud copy (another device) — keep the bigger numbers
  try {
    if (inTG && tg.CloudStorage) tg.CloudStorage.getItem(KEY, (err, v) => {
      if (err || !v) return;
      try {
        const c = JSON.parse(v);
        S.cups = Math.max(S.cups, c.cups || 0);
        for (const g in c.best || {}) S.best[g] = Math.max(S.best[g] || 0, c.best[g]);
        for (const g in c.plays || {}) S.plays[g] = Math.max(S.plays[g] || 0, c.plays[g]);
        S.ach = [...new Set([...S.ach, ...(c.ach || [])])];
        if (c.skins) { S.skins.owned = [...new Set([...S.skins.owned, ...(c.skins.owned || [])])]; }
        save(); ETO._emit();
      } catch (e) {}
    });
  } catch (e) {}

  // ---------- daily quest ----------
  const QUESTS = [
    { id: 'z15', game: 'zmeyka', text: 'Собери 15 чаёв в змейке за одну игру', test: r => r.game === 'zmeyka' && r.score >= 15 },
    { id: 't8', game: 'tapok', text: 'Попади тапком 8 раз за одну игру', test: r => r.game === 'tapok' && r.score >= 8 },
    { id: 'k150', game: 'kover', text: 'Пролети 150 метров на ковре', test: r => r.game === 'kover' && r.score >= 150 },
    { id: 'k8c', game: 'kover', text: 'Собери 8 чашек за один полёт', test: r => r.game === 'kover' && (r.cups || 0) >= 8 },
    { id: 'all3', game: null, text: 'Сыграй во все три игры сегодня', test: () => ['zmeyka', 'tapok', 'kover'].every(g => (S.quest.played || []).includes(g)) },
    { id: 'z2s', game: 'zmeyka', text: 'Поймай 2 красных носка в змейке', test: r => r.game === 'zmeyka' && (r.socks || 0) >= 2 },
  ];
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  function quest() {
    const day = today();
    if (!S.quest || S.quest.day !== day) {
      let h = 0; for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      S.quest = { day, id: QUESTS[h % QUESTS.length].id, done: false, played: [] };
      save();
    }
    const q = QUESTS.find(x => x.id === S.quest.id) || QUESTS[0];
    return { ...q, done: S.quest.done, reward: 30 };
  }

  // ---------- achievements ----------
  const ACH = [
    { id: 'first', name: 'Первая кружка', text: 'Сыграть первую игру', test: () => true },
    { id: 'all3', name: 'Многостаночник', text: 'Сыграть во все три игры', test: () => ['zmeyka', 'tapok', 'kover'].every(g => S.plays[g]) },
    { id: 'cold10', name: 'Чай остыл', text: '10 раз проиграть в змейке', test: () => (S.plays.zmeyka || 0) >= 10 },
    { id: 'tea30', name: 'Чайный мастер', text: '30 чаёв в змейке за игру', test: r => r.game === 'zmeyka' && r.score >= 30 },
    { id: 'sniper', name: 'Снайпер с 5-го этажа', text: '15 попаданий тапком за игру', test: r => r.game === 'tapok' && r.score >= 15 },
    { id: 'star', name: 'Зазвездился', text: 'Пролететь 300 метров', test: r => r.game === 'kover' && r.score >= 300 },
    { id: 'tfu', name: 'Тьфу на него', text: 'Упасть от сплетен', test: r => r.game === 'kover' && r.gossipCrash },
    { id: 'rich', name: 'Чайный магнат', text: 'Накопить 300 чашек', test: () => S.cups >= 300 },
    { id: 'duel', name: 'Принял вызов', text: 'Побить рекорд друга по ссылке', test: r => r.beatChallenge },
  ];

  // ---------- skins ----------
  const SKINS = [
    { id: 'snake.classic', slot: 'snake', key: 'classic', name: 'Обычная', price: 0, color: '#f2f1ec' },
    { id: 'snake.scarf', slot: 'snake', key: 'scarf', name: 'С красным шарфом', price: 60, color: '#d62828' },
    { id: 'snake.glasses', slot: 'snake', key: 'glasses', name: 'В очках', price: 90, color: '#141416' },
    { id: 'snake.gold', slot: 'snake', key: 'gold', name: 'Золотая', price: 200, color: '#e2b94b' },
    { id: 'slipper.classic', slot: 'slipper', key: 'classic', name: 'Тапок с красной полоской', price: 0, color: '#d62828' },
    { id: 'slipper.flower', slot: 'slipper', key: 'flower', name: 'Тапок в цветочек', price: 60, color: '#e58fb0' },
    { id: 'slipper.gold', slot: 'slipper', key: 'gold', name: 'Золотой тапок', price: 150, color: '#e2b94b' },
    { id: 'carpet.red', slot: 'carpet', key: 'red', name: 'Красный ковёр', price: 0, color: '#d62828' },
    { id: 'carpet.blue', slot: 'carpet', key: 'blue', name: 'Бабушкин синий', price: 60, color: '#3b5fa8' },
    { id: 'carpet.gold', slot: 'carpet', key: 'gold', name: 'Ковёр-люкс', price: 150, color: '#e2b94b' },
  ];

  // ---------- challenge (friend link) ----------
  function readChallenge() {
    let p = '';
    try { p = (inTG && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || ''; } catch (e) {}
    if (!p) { const m = location.search.match(/[?&](?:ch|tgWebAppStartParam)=([^&]+)/); if (m) p = decodeURIComponent(m[1]); }
    const m = p.match(/^ch_(zmeyka|tapok|kover)_(\d+)$/);
    return m ? { game: m[1], score: +m[2] } : null;
  }
  const challenge = readChallenge();

  function challengeLink(game, score) {
    const g = GAMES[game];
    return inTG || true
      ? `https://t.me/${BOT}/${g.app}?startapp=ch_${game}_${score}`
      : `${SITE}${g.path}?ch=ch_${game}_${score}`;
  }

  // ---------- events ----------
  const subs = [];
  const ETO = {
    GAMES, SKINS, ACH, inTG, tg, challenge,
    get state() { return S; },
    on(fn) { subs.push(fn); },
    _emit() { subs.forEach(f => { try { f(S); } catch (e) {} }); },
    quest,
    best: g => S.best[g] || 0,
    skin: slot => S.skins.on[slot],
    skinColor: slot => (SKINS.find(s => s.slot === slot && s.key === S.skins.on[slot]) || {}).color,
    haptic(t) { try { inTG && tg.HapticFeedback && (t === 'bad' ? tg.HapticFeedback.notificationOccurred('error') : t === 'ok' ? tg.HapticFeedback.notificationOccurred('success') : tg.HapticFeedback.impactOccurred(t || 'light')); } catch (e) {} },

    buy(id) {
      const sk = SKINS.find(s => s.id === id); if (!sk) return { ok: false };
      if (S.skins.owned.includes(id)) { S.skins.on[sk.slot] = sk.key; save(); this._emit(); return { ok: true, equipped: true }; }
      if (S.cups < sk.price) return { ok: false, need: sk.price - S.cups };
      S.cups -= sk.price; S.skins.owned.push(id); S.skins.on[sk.slot] = sk.key; save(); this._emit(); return { ok: true, bought: true };
    },

    /* r = { game, score, cups (earned in-game items), socks, gossipCrash } → summary */
    finish(r) {
      const g = r.game;
      const prevBest = S.best[g] || 0;
      const newBest = r.score > prevBest;
      if (newBest) S.best[g] = r.score;
      S.plays[g] = (S.plays[g] || 0) + 1;
      const q0 = quest();
      if (!S.quest.played.includes(g)) S.quest.played.push(g);

      // cups earned: per game formula, small and fair
      let earned = g === 'zmeyka' ? r.score : g === 'tapok' ? r.score * 2 : (r.cups || 0) + Math.floor(r.score / 25);
      if (newBest && prevBest > 0) earned += 10;

      if (challenge && challenge.game === g && r.score > challenge.score) r.beatChallenge = true;

      let questDone = false;
      if (!S.quest.done && q0.test({ ...r })) { S.quest.done = true; questDone = true; earned += q0.reward; }
      S.cups += earned;

      const achNew = [];
      for (const a of ACH) if (!S.ach.includes(a.id) && a.test({ ...r })) { S.ach.push(a.id); achNew.push(a); }
      save(); this._emit();
      if (questDone || achNew.length || newBest) this.haptic('ok');
      return { newBest, prevBest, earned, questDone, quest: q0, achNew, beatChallenge: !!r.beatChallenge };
    },

    shareText(game, score) {
      const g = GAMES[game];
      return `Я ${g.verb} ${score} ${g.unit} в «${g.title}». Побьёшь? ☕`;
    },
    challengeLink,

    challengeFriend(game, score) {
      const url = challengeLink(game, score), text = this.shareText(game, score);
      const share = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
      this.haptic('light');
      if (inTG && tg.openTelegramLink) { tg.openTelegramLink(share); return; }
      if (navigator.share) { navigator.share({ text, url }).catch(() => {}); return; }
      window.open(share, '_blank');
    },

    /* global leaderboard (server is set up by the bot workflow; empty until then) */
    api: () => (window.ETO_API || '').replace(/\/$/, ''),
    online() { return !!(this.api() && inTG); },
    async submit(game, score) {
      if (!this.online() || !(score > 0)) return null;
      try {
        const r = await fetch(this.api() + '/api/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: tg.initData, game, score }) });
        return r.ok ? await r.json() : null;
      } catch (e) { return null; }
    },
    async top(game) {
      if (!this.api()) return null;
      try {
        const r = await fetch(this.api() + '/api/top', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game, initData: inTG ? tg.initData : '' }) });
        return r.ok ? await r.json() : null;
      } catch (e) { return null; }
    },

    /* newspaper card "Вести подъезда" → PNG blob */
    async card(game, score) {
      const g = GAMES[game], W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d');
      try { await document.fonts.ready; } catch (e) {}
      x.fillStyle = '#141416'; x.fillRect(0, 0, W, H);
      x.save(); x.translate(W / 2, H / 2 - 30); x.rotate(-0.03);
      x.fillStyle = '#ecebe4'; x.fillRect(-440, -520, 880, 1000);
      x.fillStyle = '#1e1e20'; x.textAlign = 'center';
      x.font = '800 64px Unbounded, "Arial Black", sans-serif'; x.fillText('ВЕСТИ ПОДЪЕЗДА', 0, -410);
      x.fillRect(-380, -385, 760, 4); x.fillRect(-380, -375, 760, 2);
      x.fillStyle = '#5a5a5c'; x.font = '600 30px Manrope, sans-serif'; x.fillText('экстренный выпуск · только у нас', 0, -320);
      x.save(); x.rotate(-0.06); x.strokeStyle = '#d62828'; x.lineWidth = 6; x.strokeRect(-170, -270, 340, 70);
      x.fillStyle = '#d62828'; x.font = '800 36px Unbounded, sans-serif'; x.fillText('СЕНСАЦИЯ', 0, -222); x.restore();
      x.fillStyle = '#1e1e20'; x.font = '800 54px Unbounded, sans-serif';
      const head = game === 'kover' ? ['СОСЕД УЛЕТЕЛ', 'НА'] : game === 'tapok' ? ['ТАПОК ПОПАЛ', 'В ЦЕЛЬ'] : ['СОБРАНО', 'ЧАЁВ:'];
      x.fillText(head[0], 0, -90); x.fillText(head[1], 0, -20);
      x.fillStyle = '#d62828'; x.font = '800 210px Unbounded, sans-serif'; x.fillText(String(score), 0, 190);
      x.fillStyle = '#1e1e20'; x.font = '800 46px Unbounded, sans-serif'; x.fillText(game === 'tapok' ? 'РАЗ' : g.unit.toUpperCase(), 0, 260);
      x.fillStyle = '#5a5a5c'; x.font = '600 32px Manrope, sans-serif'; x.fillText('Свидетели: все. Побить рекорд: никто.', 0, 360);
      x.fillText('Пока что.', 0, 404);
      x.restore();
      x.fillStyle = '#f2f1ec'; x.textAlign = 'center'; x.font = '800 40px Unbounded, sans-serif'; x.fillText(`«${g.title}»`, W / 2, H - 120);
      x.fillStyle = '#9a9aa2'; x.font = '600 30px Manrope, sans-serif'; x.fillText(`t.me/${BOT}`, W / 2, H - 70);
      return new Promise(res => c.toBlob(res, 'image/png'));
    },

    async shareCard(game, score) {
      const blob = await this.card(game, score);
      const file = new File([blob], 'rekord.png', { type: 'image/png' });
      this.haptic('light');
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], text: this.shareText(game, score) + ' ' + challengeLink(game, score) }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      // fallback: show the picture so the person can screenshot / long-press save
      const url = URL.createObjectURL(blob);
      const ov = document.createElement('div');
      ov.className = 'eto-modal';
      ov.innerHTML = `<div class="eto-modal-box"><img alt="Карточка рекорда" src="${url}"><p>Зажми картинку, чтобы сохранить, или сделай скрин.</p><button class="eto-btn" type="button">Готово</button></div>`;
      ov.querySelector('button').onclick = () => { ov.remove(); URL.revokeObjectURL(url); };
      document.body.appendChild(ov);
    },

    /* result block inside a game-over overlay */
    resultPanel(container, game, score, res) {
      let el = container.querySelector('.eto-result');
      if (!el) { el = document.createElement('div'); el.className = 'eto-result'; const btn = container.querySelector('button'); container.insertBefore(el, btn); }
      const lines = [];
      lines.push(`<div class="eto-earned"><span class="eto-cup" aria-hidden="true"></span>+${res.earned} чашек</div>`);
      if (res.beatChallenge) lines.push(`<div class="eto-badge eto-badge-red">Ты побил(а) рекорд друга: ${challenge.score}!</div>`);
      else if (challenge && challenge.game === game) lines.push(`<div class="eto-badge">До рекорда друга: ${Math.max(0, challenge.score - score + 1)}</div>`);
      if (res.questDone) lines.push(`<div class="eto-badge eto-badge-red">Задание дня выполнено · +${res.quest.reward}</div>`);
      for (const a of res.achNew) lines.push(`<div class="eto-badge">Достижение: «${a.name}»</div>`);
      lines.push(`<div class="eto-row"><button type="button" class="eto-btn eto-btn-ghost" data-a="card">Поделиться</button><button type="button" class="eto-btn eto-btn-red" data-a="duel">Вызвать друга</button></div>`);
      el.innerHTML = lines.join('');
      el.querySelector('[data-a="card"]').onclick = () => this.shareCard(game, score);
      // send the score to the shared table and show the place
      this.submit(game, score).then(r => {
        if (!r || !r.rank) return;
        const b = document.createElement('div'); b.className = 'eto-badge'; b.textContent = `Место среди всех игроков: ${r.rank}`;
        el.insertBefore(b, el.querySelector('.eto-row'));
      });
      el.querySelector('[data-a="duel"]').onclick = () => this.challengeFriend(game, score);
    },

    /* banner on a game's start screen when opened from a friend's challenge */
    challengeBanner(container, game) {
      if (!challenge || challenge.game !== game) return;
      const b = document.createElement('div'); b.className = 'eto-badge eto-badge-red';
      b.textContent = `Тебя вызвали! Побей ${challenge.score} ${GAMES[game].unit}`;
      container.insertBefore(b, container.firstChild);
    },

    /* back to menu when opened from Igroteka */
    backButton() {
      try {
        if (inTG && tg.BackButton && sessionStorage.getItem('fromHub')) {
          tg.BackButton.show(); tg.BackButton.onClick(() => { location.href = SITE + 'igroteka/'; });
        }
      } catch (e) {}
    },
  };

  // quest progress for "all three" counts even without finishing a result elsewhere
  quest();
  window.ETO = ETO;
  try { inTG && tg.ready(); } catch (e) {}
})();
