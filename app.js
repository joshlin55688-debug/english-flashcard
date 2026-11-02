// ===================== STATE =====================
function loadState() {
  try { return JSON.parse(localStorage.getItem('flState')) || {}; } catch(e) { return {}; }
}

let _fbSaveTimer = null;
async function syncFirestore() {
  if (!window._fbUser || !window._fbDb) return;
  setSyncDot('syncing');
  try {
    const docRef = window._fbDb.collection('users').doc(window._fbUser.uid)
      .collection('state').doc('flashcard');
    await window._fbDb.runTransaction(async transaction => {
      const snap = await transaction.get(docRef);
      const remote = (snap.exists && snap.data() && snap.data().state) ? snap.data().state : {};
      STATE = FlashCore.mergeStates(STATE, remote);
      WORDS.forEach(w => {
        if (!STATE[w.id]) STATE[w.id] = { stability:0, difficulty:5.0, due:0, reps:0, lapses:0, status:'new', lastReview:0 };
      });
      localStorage.setItem('flState', JSON.stringify(STATE));
      transaction.set(docRef, {
        state: FlashCore.compactForSync(STATE),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    setSyncDot('synced');
    showSyncAlert('');
  } catch(e) {
    setSyncDot('offline');
    console.warn('Firestore sync:', e);
    // 單純沒網路時紅點就夠了；有網路卻失敗才需要明顯提醒
    if (navigator.onLine === false) return;
    showSyncAlert(e && e.code === 'permission-denied'
      ? '⚠️ 同步失敗：雲端拒絕存取，進度目前只存在這台裝置'
      : '⚠️ 同步失敗，進度目前只存在這台裝置，稍後會自動重試');
  }
}

function showSyncAlert(msg) {
  const el = document.getElementById('sync-alert');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function flushSave() {
  if (_fbSaveTimer) {
    clearTimeout(_fbSaveTimer);
    _fbSaveTimer = null;
    syncFirestore();
  }
}
window.addEventListener('pagehide', flushSave);
// 回到前景或恢復連線時重新合併雲端進度，不打斷正在看的卡片
async function pullFromCloud() {
  if (!window._fbUser || !window._fbDb) return;
  clearTimeout(_fbSaveTimer);
  _fbSaveTimer = null;
  await syncFirestore();
  updateDueInfo();
  const active = document.querySelector('.section.active');
  if (active && active.id === 'sec-progress') renderProgress();
  if (active && active.id === 'sec-vocab') renderVocab();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
  else pullFromCloud();
});
window.addEventListener('online', pullFromCloud);

function saveState() {
  localStorage.setItem('flState', JSON.stringify(STATE));
  if (!window._fbUser || !window._fbDb) return;
  setSyncDot('syncing');
  clearTimeout(_fbSaveTimer);
  _fbSaveTimer = setTimeout(() => {
    _fbSaveTimer = null;
    syncFirestore();
  }, 1500);
}

let STATE = loadState();
// Init missing words
WORDS.forEach(w => {
  if (!STATE[w.id]) STATE[w.id] = { stability:0, difficulty:5.0, due:0, reps:0, lapses:0, status:'new', lastReview:0 };
});

// ===================== TTS =====================
// Prefer natural/online voices (Edge "Natural", Chrome "Google") over robotic defaults
let _voices = {};
function pickVoices() {
  const all = speechSynthesis.getVoices();
  const pick = pre => {
    const vs = all.filter(v => v.lang.replace('_','-').startsWith(pre));
    return vs.find(v=>/natural|online/i.test(v.name)) || vs.find(v=>/google/i.test(v.name)) || vs[0] || null;
  };
  _voices.en = pick('en-US') || pick('en');
  _voices.zh = pick('zh-TW') || pick('zh');
}
if (window.speechSynthesis) {
  pickVoices();
  speechSynthesis.onvoiceschanged = pickVoices;
}
// 自動朗讀開關只存在這台裝置；手動按 🔊 不受影響
let autoSpeakOn = true;
try { autoSpeakOn = localStorage.getItem('flAutoSpeak') !== 'off'; } catch(e) {}
function autoSpeak(text, lang) { if (autoSpeakOn) speak(text, lang); }
function updateVoiceBtn() {
  const btn = document.getElementById('fc-voice-btn');
  if (btn) btn.textContent = autoSpeakOn ? '🔊 自動朗讀' : '🔇 自動朗讀';
}
function toggleAutoSpeak() {
  autoSpeakOn = !autoSpeakOn;
  try { localStorage.setItem('flAutoSpeak', autoSpeakOn ? 'on' : 'off'); } catch(e) {}
  if (!autoSpeakOn && window.speechSynthesis) window.speechSynthesis.cancel();
  updateVoiceBtn();
}
updateVoiceBtn();

function speak(text, lang) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  var utt = new SpeechSynthesisUtterance(text);
  utt.lang = lang || 'en-US';
  utt.rate = 0.85;
  var v = _voices[(lang||'en').slice(0,2)];
  if (v) utt.voice = v;
  window.speechSynthesis.speak(utt);
}

// Streak
function getDateStr(d) { return FlashCore.localDateStr(d); }

// ===================== FSRS-4.5 =====================
const FSRS_W = [
  // FSRS-4.5 官方預設值（open-spaced-repetition/awesome-fsrs wiki: The Algorithm）
  0.4872, 1.4003, 3.7145, 13.8206,  // S₀: initial stability per rating 1-4
  5.1618, 1.2298, 0.8975, 0.031,    // difficulty params
  1.6474, 0.1367, 1.0461,            // recall stability params
  2.1072, 0.0793, 0.3246, 1.587,    // forget stability params
  0.2272, 2.8755                     // hard penalty, easy bonus
];
const FSRS_DECAY = -0.5;
const FSRS_FACTOR = 19 / 81; // = 0.9^(1/-0.5) - 1

function fsrsR(t, stab) {
  // Retrievability after t days given stability stab
  if (stab <= 0) return 0;
  return Math.pow(1 + FSRS_FACTOR * t / stab, FSRS_DECAY);
}

function fsrs(id, q) { // q: 0=Again, 3=Good, 5=Easy
  const rating = q === 0 ? 1 : q === 3 ? 3 : 4; // map to FSRS 1/3/4
  const now = Date.now();
  const s = STATE[id];

  // Migrate from old SM-2 format if needed
  if (s.ef !== undefined && s.stability === undefined) {
    s.stability = Math.max(1, s.interval || 1);
    s.difficulty = Math.min(10, Math.max(1, 10 - (s.ef - 1.3) / 0.14));
    s.lapses = 0;
    s.lastReview = now - (s.interval || 1) * 86400000;
    delete s.ef; delete s.interval;
  }

  const isNew = !s.stability;

  if (isNew) {
    // First review of a new card
    s.firstSeen = getDateStr();
    s.stability = FSRS_W[rating - 1];
    s.difficulty = Math.min(10, Math.max(1, FSRS_W[4] - FSRS_W[5] * (rating - 3)));
    s.lapses = 0;
    s.reps = 1;
  } else {
    const elapsed = s.lastReview ? Math.max(0, (now - s.lastReview) / 86400000) : 0;
    const R = Math.min(1, Math.max(0.001, fsrsR(elapsed, s.stability)));

    if (rating === 1) {
      // Again – forgot: stability after lapse
      s.stability = Math.max(0.1,
        FSRS_W[11] * Math.pow(Math.max(1, s.difficulty), -FSRS_W[12]) *
        (Math.pow(s.stability + 1, FSRS_W[13]) - 1) *
        Math.exp((1 - R) * FSRS_W[14])
      );
      s.lapses = (s.lapses || 0) + 1;
    } else {
      // Recalled – stability after successful review
      const easyBonus = rating === 4 ? FSRS_W[16] : 1;
      s.stability = Math.max(0.1,
        s.stability * (
          Math.exp(FSRS_W[8]) * (11 - s.difficulty) *
          Math.pow(s.stability, -FSRS_W[9]) *
          (Math.exp((1 - R) * FSRS_W[10]) - 1) *
          easyBonus + 1
        )
      );
    }

    // Update difficulty with mean reversion toward D₀(Good)
    const nextD = s.difficulty - FSRS_W[6] * (rating - 3);
    s.difficulty = Math.min(10, Math.max(1, FSRS_W[7] * FSRS_W[4] + (1 - FSRS_W[7]) * nextD));
    s.reps = (s.reps || 0) + 1;
  }

  s.lastReview = now;
  s.modifiedAt = now;
  // stability = days until 90% retention; that IS the next interval
  s.due = now + FlashCore.fuzzInterval(Math.max(1, Math.round(s.stability))) * 86400000;
  s.status = s.stability >= 21 ? 'mastered' : (s.reps > 0 ? 'learning' : 'new');

  STATE._streak = FlashCore.applyReview(STATE._streak, getDateStr());
  saveState();
}

// ===================== NAV =====================
function showSection(id) {
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('sec-'+id).classList.add('active');
  event.target.classList.add('active');
  if (id==='progress') renderProgress();
  if (id==='vocab') renderVocab();
}

// ===================== FLASHCARD =====================
let FC = { deck:[], idx:0, flipped:false, hardCards:[] };

function getFilteredWords(topic, mode) {
  let pool = WORDS.filter(w => topic==='all' || w.topic===topic);
  if (mode === 'all') return pool;

  const used = FlashCore.dailyCounts(STATE, getDateStr());
  const pickNew = () => pool.filter(w => STATE[w.id].status === 'new')
    .slice(0, FlashCore.remaining(getDailyLimit('fc-new-limit'), used.newCards));
  // 超過複習上限時先排逾期最久的
  const pickDue = () => shuffle(pool.filter(w => FlashCore.isDue(STATE[w.id]))
    .sort((a, b) => STATE[a.id].due - STATE[b.id].due)
    .slice(0, FlashCore.remaining(getDailyLimit('fc-review-limit'), used.reviews)));

  if (mode === 'smart') return [...pickDue(), ...pickNew()];
  if (mode === 'due') return pickDue();
  return pickNew();
}

function getDailyLimit(id) {
  return parseInt(document.getElementById(id).value, 10);
}

// 每日上限只存在這台裝置
function saveDailyLimits() {
  try {
    localStorage.setItem('flNewLimit', document.getElementById('fc-new-limit').value);
    localStorage.setItem('flReviewLimit', document.getElementById('fc-review-limit').value);
  } catch(e) {}
}

function restoreDailyLimits() {
  const restore = (id, key) => {
    try {
      const v = localStorage.getItem(key);
      const el = document.getElementById(id);
      if (v !== null && [...el.options].some(o => o.value === v)) el.value = v;
    } catch(e) {}
  };
  restore('fc-new-limit', 'flNewLimit');
  restore('fc-review-limit', 'flReviewLimit');
}

function shuffle(a) { for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

function updateDueInfo() {
  const el = document.getElementById('fc-due-info');
  if (!el) return;
  const now = Date.now();
  let due = 0, newCount = 0;
  WORDS.forEach(w => {
    const s = STATE[w.id];
    if (s.status === 'new') newCount++;
    else if (FlashCore.isDue(s, now)) due++;
  });
  const doneToday = (STATE._streak && STATE._streak.week && STATE._streak.week[getDateStr()]) || 0;
  const used = FlashCore.dailyCounts(STATE, getDateStr());
  const fmt = (n, limit) => limit === 0 ? `${n}` : `${n}/${limit}`;
  el.textContent = `📌 待複習 ${due} ・ 未學習 ${newCount} ・ 今日已複習 ${doneToday} ・ 今日新字 ${fmt(used.newCards, getDailyLimit('fc-new-limit'))} ・ 今日複習 ${fmt(used.reviews, getDailyLimit('fc-review-limit'))}`;
  const undoBtn = document.getElementById('fc-undo-btn');
  if (undoBtn) undoBtn.style.display = FC.undo ? '' : 'none';
}

function initFlashcard() {
  const topic = document.getElementById('fc-topic').value;
  const mode = document.getElementById('fc-mode').value;
  const words = getFilteredWords(topic, mode);
  // smart mode already orders (due shuffled + new sequential); others get full shuffle
  FC.deck = mode === 'smart' ? words : shuffle(words);
  FC.idx = 0; FC.flipped = false; FC.hardCards = []; FC.reviewed = new Set(); FC.undo = null;
  renderFC();
}

function replayHard() {
  FC.deck = shuffle([...FC.hardCards]);
  FC.idx = 0; FC.flipped = false; FC.hardCards = []; FC.reviewed = new Set(); FC.undo = null;
  renderFC();
}

function renderFC() {
  updateDueInfo();
  const el = document.getElementById('fc-main');
  if (FC.deck.length === 0) {
    const mode = document.getElementById('fc-mode').value;
    let msg = '請更換篩選條件';
    let nextInfo = '';
    if (mode === 'smart' || mode === 'new') {
      msg = '今天的額度完成了！';
      nextInfo = '想多學可以調高每日上限';
    }
    if (mode === 'due') {
      const allFuture = WORDS.map(w => STATE[w.id].due).filter(d => d > Date.now());
      if (allFuture.length > 0) {
        const nextMs = Math.min(...allFuture);
        const h = ((nextMs - Date.now()) / 3600000);
        nextInfo = h < 1 ? '⏰ 幾分鐘後有單字需要複習' : `⏰ 下次複習：約 ${Math.ceil(h)} 小時後`;
        msg = '今天的複習已完成！';
      } else {
        msg = '還沒有學過任何單字，先用「全部單字」練習一遍吧';
      }
    }
    el.innerHTML = `<div class="fc-done"><div class="big-icon">🎉</div><h2>${msg}</h2><p style="color:var(--text2);margin-bottom:16px">${nextInfo}</p><button class="btn-primary" onclick="document.getElementById('fc-mode').value='all';initFlashcard()">練習全部單字</button></div>`;
    return;
  }
  if (FC.idx >= FC.deck.length) {
    updatePbar(FC.deck.length, FC.deck.length);
    const hardCount = FC.hardCards.length;
    const allFuture = WORDS.map(w => STATE[w.id].due).filter(d => d > Date.now());
    const nextMs = allFuture.length > 0 ? Math.min(...allFuture) : null;
    const h = nextMs ? ((nextMs - Date.now()) / 3600000) : null;
    const nextInfo = h !== null ? (h < 1 ? '⏰ 幾分鐘後有單字需要複習' : `⏰ 下次複習：約 ${Math.ceil(h)} 小時後`) : '';
    const hardBtn = hardCount > 0 ? `<button class="btn-primary" style="margin-bottom:8px" onclick="replayHard()">🔄 再練不熟的字（${hardCount}個）</button><br>` : '';
    const reviewedCount = FC.reviewed ? FC.reviewed.size : FC.deck.length;
    el.innerHTML = `<div class="fc-done"><div class="big-icon">🏆</div><h2>本輪完成！</h2><p style="margin-bottom:16px">已複習 ${reviewedCount} 個單字</p>${hardBtn}<button class="btn-primary" style="background:var(--card2);border:1px solid var(--border);color:var(--text)" onclick="initFlashcard()">🔀 重新開始</button><p style="color:var(--text2);font-size:.82rem;margin-top:14px">${nextInfo}</p></div>`;
    return;
  }
  const w = FC.deck[FC.idx];
  updatePbar(FC.idx, FC.deck.length);
  const topicMap = {level1:['Level 1','badge-level1'],level2:['Level 2','badge-level2'],level3:['Level 3','badge-level3'],level4:['Level 4','badge-level4'],level5:['Level 5','badge-level5'],level6:['Level 6','badge-level6']};
  const [topicZh, topicCls] = topicMap[w.topic];
  el.innerHTML = `
    <div class="card-area" onclick="flipCard()">
      <div class="card-inner" id="card-inner">
        <div class="card-face card-front">
          <span class="card-topic-badge ${topicCls}">${topicZh}</span>
          <div class="card-word">${w.w}</div>
          <div class="card-hint">點擊卡片查看答案</div>
          <button class="speak-btn" onclick="event.stopPropagation();speak('${w.w.replace(/'/g,"\\'")}','en-US')" title="朗讀英文">🔊</button>
        </div>
        <div class="card-face card-back">
          <span class="card-topic-badge ${topicCls}">${topicZh}</span>
          <div class="card-phonetic">${w.ph}</div>
          <div class="card-pos">${w.pos}</div>
          <div class="card-meaning">${w.zh}</div>
          <div class="card-example">"${w.ex}"</div>
          <button class="speak-btn" onclick="event.stopPropagation();speak('${w.w.replace(/'/g,"\\'")}','en-US')" title="朗讀英文">🔊</button>
        </div>
      </div>
    </div>
    <div class="rating-btns" id="rating-btns" style="display:none">
      <button class="rating-btn btn-hard" onclick="rate(0)">😓 不熟</button>
      <button class="rating-btn btn-ok" onclick="rate(3)">🤔 普通</button>
      <button class="rating-btn btn-easy" onclick="rate(5)">😊 熟悉</button>
    </div>
    <div id="rating-hint" style="text-align:center;color:var(--text2);font-size:.8rem;margin-top:10px;">翻牌後評分 • 空白鍵翻牌 • 1/2/3 評分</div>
  `;
  FC.flipped = false;
  setTimeout(function(){ autoSpeak(w.w, 'en-US'); }, 300);
}

function flipCard() {
  if (!FC.deck.length || FC.idx >= FC.deck.length) return;
  FC.flipped = !FC.flipped;
  const inner = document.getElementById('card-inner');
  if (inner) inner.classList.toggle('flipped', FC.flipped);
  if (FC.flipped) {
    const btns = document.getElementById('rating-btns');
    if (btns) btns.style.display = 'flex';
    const hint = document.getElementById('rating-hint');
    if (hint) hint.style.display = 'none';
    var w = FC.deck[FC.idx];
    if (w) setTimeout(function(){ autoSpeak(w.zh, 'zh-TW'); }, 500);
  }
}

function rate(q) {
  if (!FC.deck.length || FC.idx >= FC.deck.length) return;
  const w = FC.deck[FC.idx];
  if (!w) return;
  FC.undo = {
    id: w.id,
    card: Object.assign({}, STATE[w.id]),
    streak: STATE._streak ? JSON.parse(JSON.stringify(STATE._streak)) : null,
    deck: FC.deck.slice(),
    idx: FC.idx,
    hardCards: FC.hardCards.slice(),
    reviewed: new Set(FC.reviewed || [])
  };
  if (q === 0) {
    if (!FC.hardCards.includes(w)) FC.hardCards.push(w);
    // 不熟的字 5 張後再出現一次，當場強化記憶
    const pos = Math.min(FC.idx + 6, FC.deck.length);
    FC.deck.splice(pos, 0, w);
  }
  if (FC.reviewed) FC.reviewed.add(w.id);
  fsrs(w.id, q);
  FC.idx++;
  renderFC();
}

function undoRate() {
  const u = FC.undo;
  if (!u) return;
  STATE[u.id] = Object.assign({}, u.card, { modifiedAt: Date.now() });
  if (u.streak) STATE._streak = u.streak; else delete STATE._streak;
  FC.deck = u.deck; FC.idx = u.idx; FC.hardCards = u.hardCards; FC.reviewed = u.reviewed;
  FC.flipped = false; FC.undo = null;
  saveState();
  renderFC();
}

function updatePbar(cur, total) {
  const pct = total ? Math.round(cur/total*100) : 0;
  document.getElementById('fc-pbar').style.width = pct+'%';
  document.getElementById('fc-counter').textContent = `${cur} / ${total}`;
}

// 選完下拉選單後交還焦點，快捷鍵才能繼續使用
document.addEventListener('change', e => { if (e.target.tagName === 'SELECT') e.target.blur(); });

document.addEventListener('keydown', e => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  const sec = document.querySelector('.section.active');
  if (!sec) return;
  if (sec.id === 'sec-flashcard') {
    if (e.key === 'z' && !e.ctrlKey && !e.metaKey) { undoRate(); return; }
    if (!FC.deck.length || FC.idx >= FC.deck.length) return;
    if (e.code === 'Space' || e.code === 'ArrowRight') { e.preventDefault(); if (!FC.flipped) flipCard(); }
    if (e.key === '1') { if (FC.flipped) rate(0); }
    if (e.key === '2') { if (FC.flipped) rate(3); }
    if (e.key === '3') { if (FC.flipped) rate(5); }
  } else if (sec.id === 'sec-quiz' && QZ.deck.length) {
    if (QZ.answered) {
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowRight') { e.preventDefault(); nextQuiz(); }
    } else {
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 4) { const b = document.getElementById('qopt-' + (n - 1)); if (b) b.click(); }
    }
  }
});

// ===================== QUIZ =====================
let QZ = { deck:[], idx:0, correct:0, answered:false };

function startQuiz() {
  const topic = document.getElementById('q-topic').value;
  const count = parseInt(document.getElementById('q-count').value) || 20;
  QZ.deck = shuffle(getFilteredWords(topic, 'all')).slice(0, count);
  QZ.idx = 0; QZ.correct = 0; QZ.answered = false;
  renderQuiz();
}

function renderQuiz() {
  const el = document.getElementById('quiz-main');
  if (QZ.deck.length === 0) {
    el.innerHTML = '<p style="color:var(--text2);text-align:center;padding:40px;">請先選擇主題並點擊「開始測驗」</p>';
    updateQPbar(0, 0);
    return;
  }
  if (QZ.idx >= QZ.deck.length) {
    const pct = Math.round(QZ.correct/QZ.deck.length*100);
    const emoji = pct >= 80 ? '🏆' : pct >= 60 ? '👍' : '📚';
    el.innerHTML = `<div class="fc-done"><div class="big-icon">${emoji}</div><h2>測驗完成！</h2><p>正確率：${QZ.correct} / ${QZ.deck.length}（${pct}%）</p><button class="btn-primary" onclick="startQuiz()">再測一次</button></div>`;
    updateQPbar(QZ.deck.length, QZ.deck.length);
    return;
  }
  const w = QZ.deck[QZ.idx];
  // 干擾選項優先抽同 Level、排除同義字，提高鑑別度
  let pool = WORDS.filter(x => x.id !== w.id && x.zh !== w.zh && x.topic === w.topic);
  if (pool.length < 3) pool = WORDS.filter(x => x.id !== w.id && x.zh !== w.zh);
  const wrong = shuffle(pool).slice(0,3);
  const options = shuffle([w, ...wrong]);
  updateQPbar(QZ.idx, QZ.deck.length);
  el.innerHTML = `
    <div class="quiz-card">
      <div class="quiz-question">${w.w}</div>
      <div class="quiz-phonetic">${w.ph} &nbsp; ${w.pos}</div>
      <div class="quiz-options">
        ${options.map((o,i) => `<button class="quiz-option" id="qopt-${i}" data-id="${o.id}" onclick="answerQuiz('${o.id}','${w.id}',${i})">${o.zh}</button>`).join('')}
      </div>
      <div style="text-align:center;color:var(--text2);font-size:.75rem;margin-top:14px;">按 1～4 鍵快速作答</div>
    </div>
    <div id="quiz-reveal" class="quiz-reveal" style="display:none"></div>
  `;
  QZ.answered = false;
}

function nextQuiz() {
  if (!QZ.answered) return;
  QZ.idx++;
  renderQuiz();
}

function answerQuiz(chosen, correct, btnIdx) {
  if (QZ.answered) return;
  QZ.answered = true;
  const allBtns = document.querySelectorAll('.quiz-option');
  allBtns.forEach(b => b.classList.add('disabled'));
  const isCorrect = chosen === correct;
  if (isCorrect) {
    document.getElementById('qopt-'+btnIdx).classList.add('correct');
    QZ.correct++;
  } else {
    document.getElementById('qopt-'+btnIdx).classList.add('wrong');
    const correctBtn = document.querySelector('.quiz-option[data-id="'+correct+'"]');
    if (correctBtn) correctBtn.classList.add('correct');
  }
  fsrs(correct, FlashCore.quizRating(isCorrect));
  document.getElementById('q-score-text').textContent = `正確：${QZ.correct}`;
  // 作答後展開解答卡：音標 / 詞性 / 中文 / 例句（highlight 該字）並朗讀，強化記憶
  const w = QZ.deck[QZ.idx];
  const wordRe = new RegExp('\\b' + w.w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\w*', 'gi');
  const exHtml = (w.ex || '').replace(wordRe, m => `<mark>${m}</mark>`);
  const reveal = document.getElementById('quiz-reveal');
  const wEsc = w.w.replace(/'/g,"\\'");
  reveal.innerHTML = `
    <div class="qr-top">
      <span class="qr-word">${w.w}</span>
      <span class="qr-ph">${w.ph}</span>
      <span class="qr-pos">${w.pos}</span>
      <button class="qr-speak" onclick="speak('${wEsc}','en-US')" title="朗讀英文">🔊</button>
    </div>
    <div class="qr-zh">${w.zh}</div>
    <div class="qr-ex">"${exHtml}"</div>
    <button class="quiz-next-btn" onclick="nextQuiz()">${QZ.idx + 1 >= QZ.deck.length ? '看結果 →' : '下一題 →'}　（空白鍵 / Enter）</button>
  `;
  reveal.style.display = 'block';
  autoSpeak(w.w, 'en-US');
}

function updateQPbar(cur, total) {
  const pct = total ? Math.round(cur/total*100) : 0;
  document.getElementById('q-pbar').style.width = pct+'%';
  document.getElementById('q-prog-text').textContent = `${cur} / ${(total||'0')}`;
}

// ===================== PROGRESS =====================
function renderProgress() {
  const counts = { new:0, learning:0, mastered:0 };
  const topicCounts = { level1:{total:0,mastered:0}, level2:{total:0,mastered:0}, level3:{total:0,mastered:0}, level4:{total:0,mastered:0}, level5:{total:0,mastered:0}, level6:{total:0,mastered:0} };
  WORDS.forEach(w => {
    const s = STATE[w.id].status;
    counts[s]++;
    topicCounts[w.topic].total++;
    if (s==='mastered') topicCounts[w.topic].mastered++;
  });
  const total = WORDS.length;
  document.getElementById('st-total').textContent = total;
  document.getElementById('st-learning').textContent = counts.learning;
  document.getElementById('st-mastered').textContent = counts.mastered;
  document.getElementById('st-streak').textContent = STATE._streak?.count || 0;

  // Donut
  const newPct = counts.new/total, learnPct = counts.learning/total, mastPct = counts.mastered/total;
  const r=15.9, c=2*Math.PI*r;
  const segs = [
    {v:newPct*100, col:'#4a4a6a'},
    {v:learnPct*100, col:'#F7971E'},
    {v:mastPct*100, col:'#43E97B'},
  ];
  let offset = 25;
  let paths = '';
  segs.forEach(seg => {
    if (seg.v > 0) {
      const d = c * seg.v / 100;
      paths += `<circle cx="21" cy="21" r="${r}" fill="transparent" stroke="${seg.col}" stroke-width="4" stroke-dasharray="${d} ${c-d}" stroke-dashoffset="-${(c*(100-offset)/100)}" transform="rotate(-90 21 21)"/>`;
      offset += seg.v;
    }
  });
  document.getElementById('donut-svg').innerHTML = `<circle cx="21" cy="21" r="${r}" fill="transparent" stroke="#2D2D50" stroke-width="4"/>${paths}<text x="21" y="25" text-anchor="middle" fill="#E8E8F0" font-size="6" font-weight="bold">${counts.mastered}/${total}</text>`;
  document.getElementById('leg-new').textContent = `未學習 (${counts.new})`;
  document.getElementById('leg-learning').textContent = `學習中 (${counts.learning})`;
  document.getElementById('leg-mastered').textContent = `已熟悉 (${counts.mastered})`;

  // Topic bars
  const topicNames = {level1:'Level 1 基礎',level2:'Level 2 初階',level3:'Level 3 中階',level4:'Level 4 進階',level5:'Level 5 高階',level6:'Level 6 精通'};
  const topicColors = {level1:'var(--accent)',level2:'#5BE0FF',level3:'#C084FC',level4:'var(--warning)',level5:'#F472B6',level6:'#60A5FA'};
  document.getElementById('topic-bars').innerHTML = Object.entries(topicCounts).map(([t,tc]) => {
    const pct = tc.total ? Math.round(tc.mastered/tc.total*100) : 0;
    return `<div class="prog-row">
      <div class="prog-row-header"><span>${topicNames[t]}</span><span style="color:${topicColors[t]}">${tc.mastered}/${tc.total} (${pct}%)</span></div>
      <div class="prog-bar-bg"><div class="prog-bar-fill" style="width:${pct}%;background:${topicColors[t]}"></div></div>
    </div>`;
  }).join('');

  // Week bars
  const week = STATE._streak?.week || {};
  const days = [];
  for (let i=6;i>=0;i--) {
    const d = new Date(Date.now() - i*86400000);
    days.push({ label:['日','一','二','三','四','五','六'][d.getDay()], val:week[getDateStr(d)]||0 });
  }
  const maxVal = Math.max(...days.map(d=>d.val), 1);
  document.getElementById('week-bars').innerHTML = days.map(d => {
    const h = Math.max(4, Math.round(d.val/maxVal*70));
    return `<div class="week-bar-col"><div class="week-bar" style="height:${h}px" title="${d.val}個單字"></div><span class="week-day">${d.label}</span></div>`;
  }).join('');
}

// ===================== VOCABULARY =====================
let vocabFilter = 'all';
let vocabLimit = 200;   // 分批渲染：一次最多 200 列，避免 6000 列拖垮頁面
let _vsTimer = null;
function debounceVocab() {
  clearTimeout(_vsTimer);
  _vsTimer = setTimeout(() => { vocabLimit = 200; renderVocab(); }, 200);
}
function setVocabFilter(t) {
  vocabFilter = t;
  vocabLimit = 200;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.topic===t));
  renderVocab();
}
function vocabShowMore() { vocabLimit += 400; renderVocab(); }
function renderVocab() {
  const q = document.getElementById('vocab-search').value.toLowerCase().trim();
  const rows = WORDS.filter(w => {
    if (vocabFilter !== 'all' && w.topic !== vocabFilter) return false;
    if (q && !w.w.toLowerCase().includes(q) && !w.zh.includes(q) && !w.ex.toLowerCase().includes(q)) return false;
    return true;
  });
  document.getElementById('vocab-count').textContent = `共 ${rows.length} 字`;
  const shown = rows.slice(0, vocabLimit);
  const statusMap = { new:'<span class="status-dot status-new"></span>未學習', learning:'<span class="status-dot status-learning"></span>學習中', mastered:'<span class="status-dot status-mastered"></span>已熟悉' };
  const moreRow = rows.length > vocabLimit
    ? `<tr><td colspan="5" style="text-align:center;padding:16px"><button class="btn-primary" style="font-size:.85rem;padding:8px 20px" onclick="vocabShowMore()">顯示更多（還有 ${rows.length - vocabLimit} 字）</button></td></tr>`
    : '';
  document.getElementById('vocab-tbody').innerHTML = shown.map(w => `
    <tr>
      <td><strong>${w.w}</strong><br><small style="color:var(--text2);font-size:.75rem">${w.ex}</small></td>
      <td style="color:var(--primary-light)">${w.ph}</td>
      <td><span style="font-size:.75rem;background:var(--primary);color:#fff;padding:2px 6px;border-radius:8px">${w.pos}</span></td>
      <td>${w.zh}</td>
      <td style="white-space:nowrap">${statusMap[STATE[w.id].status]}</td>
    </tr>
  `).join('') + moreRow;
}

// ===================== INIT =====================
restoreDailyLimits();
initFlashcard();
renderVocab();

// ===================== FIREBASE SYNC =====================
// ⚠️ 請先到 https://console.firebase.google.com 建立專案，填入下方設定後才能啟用同步
const FB_CONFIG = {
  apiKey: "AIzaSyAL0bAP1QVY9Ec22kq-M_aaL4VEnU8OqhE",
  authDomain: "flash-card-76dbb.firebaseapp.com",
  projectId: "flash-card-76dbb",
  storageBucket: "flash-card-76dbb.firebasestorage.app",
  messagingSenderId: "169619727280",
  appId: "1:169619727280:web:c536274e35b9c891016c75",
  measurementId: "G-15BL52B3KH"
};

function setSyncDot(state) {
  const dot = document.getElementById('sync-dot');
  if (!dot) return;
  const cls = { synced:'synced', syncing:'syncing', offline:'offline' };
  dot.className = 'sync-dot' + (cls[state] ? ' ' + cls[state] : '');
  dot.title = { idle:'未登入', syncing:'同步中…', synced:'已同步', offline:'離線' }[state] || '';
}

function updateAuthUI(user) {
  const el = document.getElementById('auth-ui');
  if (!el) return;
  if (user) {
    el.innerHTML = `
      <span class="auth-name" title="${user.email}">${user.displayName || user.email}</span>
      ${user.photoURL ? `<img class="auth-avatar" src="${user.photoURL}" alt="">` : ''}
      <button class="auth-btn" onclick="fbSignOut()">登出</button>
    `;
  } else {
    el.innerHTML = `<button class="auth-btn" onclick="signInWithGoogle()">☁️ 登入同步</button>`;
    setSyncDot('idle');
    showSyncAlert('');
  }
}

async function loadFromFirestore() {
  if (!window._fbUser || !window._fbDb) return;
  await syncFirestore();
  initFlashcard();
  renderVocab();
}

function signInWithGoogle() {
  if (!window._fbAuth) { alert('請先設定 Firebase 設定（見說明）'); return; }
  const provider = new firebase.auth.GoogleAuthProvider();
  window._fbAuth.signInWithPopup(provider).catch(e => alert('登入失敗：' + e.message));
}

function fbSignOut() {
  if (window._fbAuth) window._fbAuth.signOut();
}

function initFirebase() {
  if (FB_CONFIG.apiKey === 'YOUR_API_KEY') {
    // Show setup instructions in progress section
    const setupHtml = `<div class="auth-setup">
      <h3>☁️ 啟用跨裝置同步</h3>
      <p>請依下列步驟設定 Firebase，完成後同步功能即可使用：</p>
      <ol>
        <li>前往 <a href="https://console.firebase.google.com" target="_blank" style="color:var(--primary)">console.firebase.google.com</a> 建立新專案</li>
        <li>在「驗證」→「登入方式」啟用 <strong>Google</strong></li>
        <li>在「Firestore Database」建立資料庫（以測試模式開始）</li>
        <li>前往「專案設定」→「您的應用程式」新增網頁應用程式，複製 <code>firebaseConfig</code></li>
        <li>在授權網域加入 <code>joshlin55688-debug.github.io</code></li>
        <li>在本檔案 <code>&lt;script&gt;</code> 中找到 <code>FB_CONFIG</code>，將您的設定值貼入</li>
        <li>儲存並重新部署，即可使用 Google 帳號登入同步進度</li>
      </ol>
    </div>`;
    const progSec = document.getElementById('sec-progress');
    if (progSec && !progSec.querySelector('.auth-setup')) {
      progSec.insertAdjacentHTML('afterbegin', setupHtml);
    }
    return;
  }
  try {
    const app = firebase.initializeApp(FB_CONFIG);
    window._fbAuth = firebase.auth();
    window._fbDb = firebase.firestore();
    window._fbAuth.onAuthStateChanged(user => {
      window._fbUser = user;
      updateAuthUI(user);
      if (user) loadFromFirestore();
    });
  } catch(e) { console.warn('Firebase init error:', e); }
}

initFirebase();

// ===================== BACKUP =====================
function exportBackup() {
  const now = Date.now();
  const backup = FlashCore.makeBackup(STATE, now);
  const jsonStr = JSON.stringify(backup, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `flashlearn-backup-${FlashCore.localDateStr(new Date(now))}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importBackup(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const text = e.target.result;
      const imported = FlashCore.parseBackup(text);
      STATE = FlashCore.mergeStates(STATE, imported);
      WORDS.forEach(w => {
        if (!STATE[w.id]) STATE[w.id] = { stability:0, difficulty:5.0, due:0, reps:0, lapses:0, status:'new', lastReview:0 };
      });
      saveState();
      initFlashcard();
      renderVocab();
      renderProgress();
      const studied = WORDS.filter(w => STATE[w.id] && (STATE[w.id].status !== 'new' || STATE[w.id].reps > 0)).length;
      alert(`匯入成功！已學習 ${studied} 個單字`);
    } catch (err) {
      alert('備份檔格式不正確');
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

// ===================== PWA / 手機 App 模式 =====================
(function(){
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const btn = document.getElementById('install-btn');

  // Android / Chrome：攔截安裝提示，顯示安裝鈕
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    window._deferredPrompt = e;
    if (btn && !isStandalone) btn.style.display = '';
  });
  window.addEventListener('appinstalled', () => {
    window._deferredPrompt = null;
    if (btn) btn.style.display = 'none';
  });
  // iOS Safari：無 beforeinstallprompt，未安裝時直接顯示安裝鈕（點擊給說明）
  if (isIOS && !isStandalone && btn) btn.style.display = '';

  // 註冊 Service Worker（離線可用）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(()=>{}));
  }
})();

function installApp(){
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  if (window._deferredPrompt){
    window._deferredPrompt.prompt();
    window._deferredPrompt.userChoice.finally(()=>{ window._deferredPrompt = null; });
  } else if (isIOS){
    document.getElementById('ios-install').style.display = 'flex';
  } else {
    document.getElementById('ios-install').style.display = 'flex';
  }
}
