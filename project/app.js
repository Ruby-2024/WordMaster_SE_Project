/* Vocab Lite - 业务逻辑（LocalStorage + Leitner + 拼写容错 + PWA 队列）
   本版：拼写模式先显示单词，确认后隐藏再拼写（学习与复习两处一致） */
const STORAGE = {
  settings: 'vl.settings',
  decks: 'vl.decks',
  cards: 'vl.cards',
  stats: 'vl.stats',
  pvp: 'vl.pvp' // 新增排位赛存储键
};

// 默认设置
const DEFAULT_SETTINGS = {
  theme: 'system',
  study: {
    defaultTab: 'home',          // 'home' | 'study' | 'review'
    defaultStudyMode: 'memory',  // 'memory' | 'spelling'
    defaultReviewMode: 'spelling'
  },
  daily: { newPerDay: 10, ratio: 0.5 },
  rank: {
    levels: [
      { name: '秀才', vls: 0 },
      { name: '举人', vls: 50 },
      { name: '进士', vls: 200 },
      { name: '翰林', vls: 500 },
      { name: '大学士', vls: 1000 },
      { name: '状元', vls: 2000 }
    ]
  },
  ai: {
    base: 'https://api.deepseek.com/v1',  // 直接使用 DeepSeek API
    model: 'deepseek-chat',
    temperature: 0.7,
    max_tokens: 2048,
    system: 'You are a professional English dictionary and language tutor. Your task is to provide clear, accurate, and concise explanations for any English word or phrase provided by the user. Your response must include the part of speech, a precise Chinese definition, and one or more authentic English example sentences with clear Chinese translations. Maintain a clear and professional format.',
    maxTurns: 6,
    userKey: '',  // 直接设置默认 key
    persistUserKey: false
  }
};

// Leitner 间隔（天）
const INTERVAL_NORMAL = [1, 2, 4, 7, 15];
const INTERVAL_STRONG = [2, 4, 7, 15, 30];

function todayStr(d = new Date()) { return d.toISOString().slice(0,10); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate()+days); return d; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// CSV 解析（简化）
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const hasHeader = /word/i.test(lines[0]);
  const rows = hasHeader ? lines.slice(1) : lines;
  return rows.map(l => {
    const [word, meaning, example] = l.split(/,(.+)?/).flatMap(s => s?.split(',') ?? []).slice(0,3).map(s=>s?.trim()||'');
    return { word, meaning, example };
  }).filter(x => x.word && x.meaning);
}

// Levenshtein（最简）
function levenshtein(a, b) {
  a = (a||'').toLowerCase(); b = (b||'').toLowerCase();
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_,i)=>[i, ...Array(n).fill(0)]);
  for (let j=1;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++) {
    for (let j=1;j<=n;j++) {
      dp[i][j] = Math.min(
        dp[i-1][j]+1,
        dp[i][j-1]+1,
        dp[i-1][j-1] + (a[i-1]===b[j-1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

// LocalStorage
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
};

function isDue(card, date = new Date()) {
  if (!card.due) return true;
  return new Date(card.due) <= date;
}

function updateLeitner(card, score) {
  if (!card.box) card.box = 1;
  if (score <= 2) {
    card.box = 1;
    card.due = todayStr(addDays(new Date(), INTERVAL_NORMAL[0]));
  } else if (score <= 4) {
    card.box = clamp(card.box + 1, 1, 5);
    const interval = INTERVAL_NORMAL[clamp(card.box-1,0,4)];
    card.due = todayStr(addDays(new Date(), interval));
  } else {
    card.box = clamp(card.box + 1, 1, 5);
    const interval = INTERVAL_STRONG[clamp(card.box-1,0,4)];
    card.due = todayStr(addDays(new Date(), interval));
  }
  return card;
}

function buildQueue(allCards, settings, statsToday) {
  const enabled = Object.values(allCards);
  const learnedToday = statsToday.learned || 0;
  const quotaNew = Math.max(0, settings.daily.newPerDay - learnedToday);
  const newCount = Math.round(quotaNew * settings.daily.ratio);
  const reviewCount = Math.max(1, settings.daily.newPerDay - newCount);

  const due = enabled.filter(c => c.box && isDue(c)).sort((a,b)=>new Date(a.due)-new Date(b.due));
  const unseen = enabled.filter(c => !c.box).slice(0, newCount);

  return {
    studyQueue: [...unseen, ...due.slice(0, reviewCount)],
    reviewQueue: due.slice(0, Math.max(reviewCount, 1))
  };
}

// 官阶机制：根据 VLS 获取官阶名称
function getRank(vls, settings) {
  const levels = settings.rank.levels.sort((a, b) => b.vls - a.vls);
  for (const level of levels) {
    if (vls >= level.vls) return level.name;
  }
  return levels[levels.length - 1].name;
}

// 官阶机制：计算 VLS (Vocabulary Level Score)
function calculateVLS(cards) {
  let vls = 0;
  for (const card of Object.values(cards)) {
    // VLS = sum(box_i)
    if (card.box && card.box > 0) {
      vls += card.box;
    }
  }
  return vls;
}

function loadStats(cards, settings) {
  let s = LS.get(STORAGE.stats, { date: todayStr(), learned: 0, reviewed: 0, streak: 0, vls: 0, rank: '秀才', pvp: { level: '青铜', stars: 1, wins: 0, losses: 0 } });  // 每日统计重置
  if (s.date !== todayStr()) {
    s = { 
      date: todayStr(), 
      learned: 0, 
      reviewed: 0, 
      streak: (s.learned||s.reviewed) ? (s.streak+1) : s.streak,
      vls: s.vls, // 保持 VLS
      rank: s.rank, // 保持官阶
      pvp: s.pvp // 保持排位赛状态
    };
    LS.set(STORAGE.stats, s);
  }
  
  // 确保 VLS 和 Rank 存在 (兼容旧数据)
  if (s.vls === undefined || s.rank === undefined) {
    s.vls = calculateVLS(cards);
    s.rank = getRank(s.vls, settings);
    LS.set(STORAGE.stats, s);
  }
  
  // 确保 pvp 存在 (兼容旧数据)
  if (s.pvp === undefined) {
    s.pvp = { level: '青铜', stars: 1, wins: 0, losses: 0 };
    LS.set(STORAGE.stats, s);
  }
  return s;
}
function saveStats(s) { LS.set(STORAGE.stats, s); }

// 排位赛机制：更新等级和星级
function updatePVP(pvp, isWin) {
  const levels = ['青铜', '白银', '黄金', '铂金', '钻石', '王者'];
  let currentLevelIndex = levels.indexOf(pvp.level);
  let currentStars = pvp.stars;

  if (isWin) {
    pvp.wins++;
    currentStars++;
    if (currentLevelIndex < 5 && currentStars > 3) { // 非王者，星级满3升一级
      currentLevelIndex++;
      currentStars = 1;
    } else if (currentLevelIndex === 5 && currentStars > 1) { // 王者，星级满1不再升
      currentStars = 1;
    }
  } else {
    pvp.losses++;
    if (currentLevelIndex === 5) { // 王者，输了不掉星
      currentStars = 1;
    } else if (currentLevelIndex > 0) { // 非青铜，输了掉星
      currentStars--;
      if (currentStars < 1) { // 星级掉光降一级
        currentLevelIndex--;
        currentStars = 3;
      }
    } else { // 青铜，输了不掉星
      currentStars = 1;
    }
  }

  pvp.level = levels[currentLevelIndex];
  pvp.stars = currentStars;
  return pvp;
}

// 排位赛机制：生成挑战任务
function generateChallenge(cards, count = 10) {
  const learnedCards = Object.values(cards).filter(c => c.box && c.box > 0);
  if (learnedCards.length < count) {
    return { error: `至少需要掌握 ${count} 个单词才能开始排位赛。` };
  }
  
  // 随机抽取 count 个单词
  const shuffled = learnedCards.sort(() => 0.5 - Math.random());
  const challengeWords = shuffled.slice(0, count);
  
  return { words: challengeWords, count };
}

// 排位赛机制：生成虚拟对手得分 (基于用户当前等级)
function generateOpponentScore(pvp) {
  const levels = ['青铜', '白银', '黄金', '铂金', '钻石', '王者'];
  const levelIndex = levels.indexOf(pvp.level);
  
  // 基础分 (0-1000)
  let baseScore = 500 + levelIndex * 100 + (pvp.stars - 1) * 30;
  
  // 随机浮动 (-50 到 +50)
  const randomOffset = Math.floor(Math.random() * 101) - 50;
  
  return Math.max(100, baseScore + randomOffset);
}

// 排位赛机制：判定挑战结果
function resolvePVP(pvp, userScore, opponentScore) {
  const isWin = userScore > opponentScore;
  const newPVP = updatePVP(pvp, isWin);
  return { isWin, newPVP, opponentScore };
}

function deckProgress(cards, deck) {
  const prefix = `[${deck.id}]`;
  const total = Object.values(cards).filter(c => c._deck?.startsWith(prefix)).length || deck.size;
  const learned = Object.values(cards).filter(c => c._deck?.startsWith(prefix) && c.box >= 2).length;
  return total ? Math.round(learned/total*100) : 0;
}

document.addEventListener('alpine:init', () => {
  Alpine.data('vocabApp', () => ({
    tab: 'home',
    theme: 'light',
    settings: structuredClone(DEFAULT_SETTINGS),
    decks: [],
    cards: {},

    // 队列与卡片状态
    queue: [],
    currentCard: null,
    showMeaning: false,

    reviewQueue: [],
    reviewCard: null,
    showReviewMeaning: false,

    // 模式
    modeStudy: 'memory',
    modeReview: 'spelling',

    // 拼写阶段（学习/复习）
    spellingStudyStage: 'show', // 'show' | 'input'
    spellingStage: 'show',      // 'show' | 'input'

    // 拼写输入与反馈
    spellingStudyInput: '',
    spellingStudyFeedback: '',
    spellingInput: '',
    spellingFeedback: '',

    // 统计
    statsToday: null, // 延迟加载，需要 cards 和 settings
    rankLevels: [], // 官阶等级列表
    
    // 排位赛状态
    pvpChallenge: null, // 当前挑战任务
    pvpOpponentScore: 0, // 虚拟对手得分
    pvpStartTime: 0, // 挑战开始时间
    pvpResult: null, // 挑战结果
    pvpInput: '', // 排位赛拼写输入
    pvpFeedback: '', // 排位赛反馈
    pvpCurrentIndex: 0, // 当前挑战单词索引
    pvpCorrectCount: 0, // 正确单词数

    // AI
    aiState: { messages: [], input: '', thinking: false },

    // 评分状态
    lastGrade: null,  // 添加一个新属性用于跟踪上一次的评分
    currentGradeUI: null, // 添加UI显示状态

    async init() {
      const s = LS.get(STORAGE.settings, DEFAULT_SETTINGS);
      this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), s);

      if (!this.settings.ai.persistUserKey) {
        const loaded = (s.ai && 'userKey' in s.ai) ? s.ai.userKey : '';
        this.settings.ai.userKey = loaded || this.settings.ai.userKey || '';
      }

      this.applyTheme();
      await this.loadBuiltins();
      const decksLS = LS.get(STORAGE.decks, this.decks);
      this.decks = decksLS.length ? decksLS : this.decks;
      this.cards = LS.get(STORAGE.cards, this.cards);
      
      // 加载统计数据 (需要 cards 和 settings)
      this.statsToday = loadStats(this.cards, this.settings);
      this.rankLevels = this.settings.rank.levels; // 确保 rankLevels 被初始化

      // 默认页&模式
      this.tab = this.settings.study.defaultTab || 'home';
      
      // 确保 tab 存在
      if (!['home', 'study', 'review', 'pvp'].includes(this.tab)) {
        this.tab = 'home';
      }
      this.modeStudy = this.settings.study.defaultStudyMode || 'memory';
      this.modeReview = this.settings.study.defaultReviewMode || 'spelling';

      this.refreshQueues();
    },

    // ----------------------------------------------------------------
    // 排位赛逻辑
    // ----------------------------------------------------------------
    startPVP() {
      const challenge = generateChallenge(this.cards);
      if (challenge.error) {
        alert(challenge.error);
        return;
      }
      
      this.pvpChallenge = challenge;
      this.pvpOpponentScore = generateOpponentScore(this.statsToday.pvp);
      this.pvpStartTime = Date.now();
      this.pvpResult = null;
      this.pvpInput = '';
      this.pvpFeedback = '';
      this.pvpCurrentIndex = 0;
      this.pvpCorrectCount = 0;
      this.tab = 'pvp';
      
      // 聚焦输入框
      setTimeout(() => {
        const input = document.querySelector('input[x-model="pvpInput"]');
        if (input) input.focus();
      }, 100);
    },
    
    checkPVPSpelling() {
      if (!this.pvpChallenge) return;
      
      const currentWord = this.pvpChallenge.words[this.pvpCurrentIndex];
      const guess = (this.pvpInput || '').trim().toLowerCase();
      const ans = currentWord.word.trim().toLowerCase();
      
      if (!guess) return;
      
      const dist = levenshtein(guess, ans);
      const maxDist = Math.ceil(ans.length * 0.2);
      const ok = dist <= maxDist && guess.length === ans.length;
      
      if (ok) {
        this.pvpCorrectCount++;
        this.pvpFeedback = `✅ 正确: ${currentWord.word}`;
      } else {
        this.pvpFeedback = `❌ 错误。正确拼写: ${currentWord.word}`;
      }
      
      this.pvpInput = '';
      this.pvpCurrentIndex++;
      
      if (this.pvpCurrentIndex >= this.pvpChallenge.count) {
        this.endPVP();
      } else {
        // 聚焦输入框
        setTimeout(() => {
          const input = document.querySelector('input[x-model="pvpInput"]');
          if (input) input.focus();
        }, 100);
      }
    },
    
    endPVP() {
      const timeTaken = (Date.now() - this.pvpStartTime) / 1000; // 秒
      const totalWords = this.pvpChallenge.count;
      const correctRate = this.pvpCorrectCount / totalWords;
      
      // 挑战得分计算：正确率 * 1000 - 用时 (秒)
      const userScore = Math.floor(correctRate * 1000 - timeTaken);
      
      const result = resolvePVP(this.statsToday.pvp, userScore, this.pvpOpponentScore);
      this.statsToday.pvp = result.newPVP;
      saveStats(this.statsToday);
      
      this.pvpResult = {
        userScore,
        opponentScore: result.opponentScore,
        isWin: result.isWin,
        timeTaken: timeTaken.toFixed(1),
        correctCount: this.pvpCorrectCount,
        totalWords: totalWords,
        oldLevel: this.statsToday.pvp.level,
        oldStars: this.statsToday.pvp.stars,
        newLevel: result.newPVP.level,
        newStars: result.newPVP.stars
      };
      
      this.pvpChallenge = null; // 结束挑战
    },

    async loadBuiltins() {
      const builtins = [
        { id: 'demo', title: 'Demo', path: 'wordlists/demo.json' },
        { id: 'cet4', title: 'CET4(示例100)', path: 'wordlists/cet4.json' }
      ];
      const decks = [];
      for (const b of builtins) {
        try {
          const res = await fetch(b.path); if (!res.ok) continue;
          const data = await res.json();
          decks.push({ id: b.id, title: data.title || b.title, size: data.entries.length, enabled: b.id==='demo' });
          for (const it of data.entries) {
            if (!it.word || !it.meaning) continue;
            const key = it.word.toLowerCase();
            if (!this.cards[key]) {
              this.cards[key] = { word: it.word, meaning: it.meaning, example: it.example, box: undefined, due: null, _deck: `[${b.id}] ${data.title}` };
            }
          }
        } catch {}
      }
      this.decks = decks;
      LS.set(STORAGE.cards, this.cards);
      LS.set(STORAGE.decks, this.decks);
    },

    applyTheme() {
      const sysDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      const mode = this.settings.theme==='system' ? (sysDark?'dark':'light') : this.settings.theme;
      document.documentElement.classList.toggle('dark', mode==='dark');
      this.theme = mode;
      LS.set(STORAGE.settings, this.settings);
    },

    saveSettings() {
      const copy = structuredClone(this.settings);
      if (!copy.ai.persistUserKey) copy.ai.userKey = '';
      LS.set(STORAGE.settings, copy);
      alert('已保存设置');
      this.refreshQueues();
    },

    toggleDeck(id, enabled) {
      const d = this.decks.find(x=>x.id===id); if (!d) return;
      d.enabled = enabled;
      LS.set(STORAGE.decks, this.decks);
      this.refreshQueues();
    },

    progressOfDeck(d) { return deckProgress(this.cards, d); },

    async importWordlist(ev) {
      const f = ev.target.files?.[0]; if (!f) return;
      const text = await f.text();
      let entries = [];
      try {
        if (f.name.endsWith('.json')) {
          const data = JSON.parse(text); entries = Array.isArray(data) ? data : data.entries || [];
        } else {
          entries = parseCSV(text);
        }
      } catch (e) { alert('解析失败：'+e.message); return; }
      const id = f.name.replace(/\.[^.]+$/,'').toLowerCase();
      const title = f.name;
      let size = 0;
      for (const it of entries) {
        if (!it.word || !it.meaning) continue;
        const key = it.word.toLowerCase();
        this.cards[key] = this.cards[key] || { ...it, box: undefined, due: null, _deck: `[${id}] ${title}` };
        size++;
      }
      this.decks.push({ id, title, size, enabled: true });
      LS.set(STORAGE.cards, this.cards);
      LS.set(STORAGE.decks, this.decks);
      alert(`已导入 ${size} 条`);
      this.refreshQueues();
      ev.target.value = '';
    },

    refreshQueues() {
      const enabledIds = new Set(this.decks.filter(d=>d.enabled).map(d=>d.id));
      const merged = {};
      for (const [k, c] of Object.entries(this.cards)) {
        const did = (c._deck?.match(/^\[(.+?)\]/)||[])[1];
        if (!did || enabledIds.has(did)) merged[k]=c;
      }
      const { studyQueue, reviewQueue } = buildQueue(merged, this.settings, this.statsToday);
      this.queue = studyQueue;
      this.reviewQueue = reviewQueue;

      this.currentCard = this.queue.shift() || null;
      this.reviewCard = this.reviewQueue.shift() || null;

      // 重置所有状态（包含拼写阶段）
      this.showMeaning = false;
      this.showReviewMeaning = false;
      this.spellingStudyStage = 'show';
      this.spellingStage = 'show';
      this.spellingStudyInput = '';
      this.spellingStudyFeedback = '';
      this.spellingInput = '';
      this.spellingFeedback = '';

      // 重置评分状态
      this.lastGrade = null;
      this.currentGradeUI = null; // 重置UI显示状态
    },

    onSwitchStudyMode() {
      this.showMeaning = false;
      // 重置拼写阶段与输入
      this.spellingStudyStage = 'show';
      this.spellingStudyInput = '';
      this.spellingStudyFeedback = '';
    },
    onSwitchReviewMode() {
      this.showReviewMeaning = false;
      this.spellingStage = 'show';
      this.spellingInput = '';
      this.spellingFeedback = '';
    },

    nextCard() {
      // 更新当前卡片的学习状态
      if (this.lastGrade) {
        const beforeBox = this.currentCard.box;
        updateLeitner(this.currentCard, this.lastGrade);
        
        // 1. 更新统计数据
        if (!this.currentCard._countedToday) {
          if (!beforeBox) this.statsToday.learned++;
          else this.statsToday.reviewed++;
          this.currentCard._countedToday = true;
        } else {
          this.statsToday.reviewed++;
        }
        
        // 2. 更新 VLS 和官阶
        this.statsToday.vls = calculateVLS(this.cards);
        this.statsToday.rank = getRank(this.statsToday.vls, this.settings);
        
        saveStats(this.statsToday);
        this.cards[this.currentCard.word.toLowerCase()] = this.currentCard;
        LS.set(STORAGE.cards, this.cards);
      }

      // 获取下一张卡片并重置状态
      this.currentCard = this.queue.shift() || null;
      this.showMeaning = false;
      this.lastGrade = null;
      this.currentGradeUI = null;
      
      if (!this.currentCard) this.refreshQueues();
    },

    grade(score) {
      if (!this.currentCard) return;
      this.lastGrade = score;
      this.currentGradeUI = score;
    },

    // 学习页：拼写流程
    startSpellingStudy() {
      this.spellingStudyStage = 'input';
      this.spellingStudyInput = '';
      this.spellingStudyFeedback = '';
      // 聚焦输入框
      setTimeout(() => {
        const input = document.querySelector('input[x-model="spellingStudyInput"]');
        if (input) input.focus();
      }, 100);
    },
    checkSpellingStudy() {
      if (!this.currentCard) return;
      const guess = (this.spellingStudyInput||'').trim().toLowerCase();
      const ans = this.currentCard.word.trim().toLowerCase();
      if (!guess) return;
      
      // 修改拼写检查逻辑：必须完全匹配或在允许的编辑距离内
      const dist = levenshtein(guess, ans);
      const maxDist = Math.ceil(ans.length * 0.2);
      const ok = dist <= maxDist && guess.length === ans.length; // 添加长度检查
      
      if (ok) {
        this.spellingStudyFeedback = `✅ 正确：${this.currentCard.word}` + 
          (dist ? `（${dist} 处差异，已算对）` : '') + 
          `\n\n释义：${this.currentCard.meaning}` + 
          (this.currentCard.example ? `\n\n例句：${this.currentCard.example}` : '');
        updateLeitner(this.currentCard, 4);
        if (!this.currentCard._countedToday) {
          this.statsToday.learned++;
          this.currentCard._countedToday = true;
        } else {
          this.statsToday.reviewed++;
        }
        // 1. 更新统计数据
        if (!this.currentCard._countedToday) {
          this.statsToday.learned++;
          this.currentCard._countedToday = true;
        } else {
          this.statsToday.reviewed++;
        }
        
        // 2. 更新 VLS 和官阶
        this.statsToday.vls = calculateVLS(this.cards);
        this.statsToday.rank = getRank(this.statsToday.vls, this.settings);
        
        saveStats(this.statsToday);
        this.cards[this.currentCard.word.toLowerCase()] = this.currentCard;
        LS.set(STORAGE.cards, this.cards);
        this.spellingStudyStage = 'correct';
      } else {
        this.spellingStudyFeedback = `❌ 不正确。正确拼写：${this.currentCard.word}\n请重新输入或点击跳过进入下一题`;
        this.spellingStudyInput = '';
      }
    },

    // 复习页：记忆评分
    gradeReview(score) {
      if (!this.reviewCard) return;
      updateLeitner(this.reviewCard, score);
      
      // 1. 更新统计数据
      this.statsToday.reviewed++;
      
      // 2. 更新 VLS 和官阶
      this.statsToday.vls = calculateVLS(this.cards);
      this.statsToday.rank = getRank(this.statsToday.vls, this.settings);
      
      saveStats(this.statsToday);
      this.cards[this.reviewCard.word.toLowerCase()] = this.reviewCard;
      LS.set(STORAGE.cards, this.cards);
      this.nextReview();
    },

    // 复习页：拼写流程
    startSpelling() {
      this.spellingStage = 'input';
      this.spellingInput = '';
      this.spellingFeedback = '';
    },
    checkSpelling() {
      if (!this.reviewCard) return;
      const guess = (this.spellingInput||'').trim();
      const ans = this.reviewCard.word.trim();
      if (!guess) return;
      const dist = levenshtein(guess, ans);
      const ok = dist <= Math.ceil(ans.length * 0.2);
      if (ok) {
        this.spellingFeedback = `✅ 正确：${ans}` + (dist?`（${dist} 处差异，已算对）`:'');
        updateLeitner(this.reviewCard, 4);
      } else {
        this.spellingFeedback = `❌ 不正确。正确拼写：${ans}`;
        updateLeitner(this.reviewCard, 1);
      }
      this.statsToday.reviewed++;
      saveStats(this.statsToday);
      this.cards[this.reviewCard.word.toLowerCase()] = this.reviewCard;
      LS.set(STORAGE.cards, this.cards);
      setTimeout(()=>this.nextReview(), 600);
    },

    nextReview() {
      this.reviewCard = this.reviewQueue.shift() || null;
      this.showReviewMeaning = false;
      this.spellingStage = 'show';
      this.spellingInput = '';
      this.spellingFeedback = '';
      if (!this.reviewCard) this.refreshQueues();
    },

    // 数据导入导出
    exportAll() {
      const exportSettings = structuredClone(this.settings);
      if (!exportSettings.ai.persistUserKey) exportSettings.ai.userKey = '';
      const obj = {
        [STORAGE.settings]: exportSettings,
        [STORAGE.decks]: this.decks,
        [STORAGE.cards]: this.cards,
        [STORAGE.stats]: this.statsToday
      };
      const blob = new Blob([JSON.stringify(obj, null, 2)], {type:'application/json'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `vocab-lite-${todayStr()}.json`;
      a.click(); URL.revokeObjectURL(a.href);
    },
    async importAll(ev) {
      const f = ev.target.files?.[0]; if (!f) return;
      try {
        const text = await f.text();
        const data = JSON.parse(text);
        const loaded = data[STORAGE.settings] || this.settings;
        if (!loaded.ai?.persistUserKey && loaded.ai) loaded.ai.userKey = '';
        this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), loaded);
        this.decks = data[STORAGE.decks] || this.decks;
        this.cards = data[STORAGE.cards] || this.cards;
        this.statsToday = data[STORAGE.stats] || this.statsToday;
        this.applyTheme();
        LS.set(STORAGE.settings, this.settings);
        LS.set(STORAGE.decks, this.decks);
        LS.set(STORAGE.cards, this.cards);
        LS.set(STORAGE.stats, this.statsToday);
        alert('已导入');
        this.refreshQueues();
      } catch (e) { alert('导入失败：'+e.message); }
      ev.target.value = '';
    },

    clearAll() {
      if (!confirm('确认清空所有数据？不可恢复。')) return;
      localStorage.removeItem(STORAGE.settings);
      localStorage.removeItem(STORAGE.decks);
      localStorage.removeItem(STORAGE.cards);
      localStorage.removeItem(STORAGE.stats);
      location.reload();
    },

    // AI 小窗
    openAI() {
      if (!this.settings.ai.base) { 
        alert('请先在 设置 → AI 参数 配置代理地址 AI_BASE'); 
        return; 
      }
      
      const w = this.currentCard?.word || this.reviewCard?.word;
      const m = this.currentCard?.meaning || this.reviewCard?.meaning;
      
      let prompt = '请作为英文词汇助教回答问题。';
      if (w && m) {
        prompt = `请解释英文单词："${w}"\n当前释义：${m}`;
      }
      
      this.aiState.messages = [{ 
        id: Date.now()+':sys', 
        role: 'user', 
        content: prompt 
      }];
      
      this.$refs.aidlg.showModal();
    },
    async sendAI() {
      if (this.aiState.thinking) return;
      
      const input = (this.aiState.input||'').trim();
      if (!input) {
        // 如果没有输入内容，则发送当前单词的提示
        const w = this.currentCard?.word || this.reviewCard?.word;
        const m = this.currentCard?.meaning || this.reviewCard?.meaning;
        if (w && m) {
          const prompt = `请解释英文单词："${w}"\n当前释义：${m}\n`;
          this.aiState.messages = [{ 
            id: Date.now()+':sys', 
            role: 'user', 
            content: prompt 
          }];
        } else {
          return; // 如果既没有输入也没有当前单词，则不发送
        }
      } else {
        this.aiState.messages.push({ id: Date.now()+':u', role:'user', content: input });
        this.aiState.input = '';
      }
      
      this.aiState.thinking = true;
      
      try {
        const reply = await window.vlAI.chat(
          this.aiState.messages.map(m=>({role:m.role, content:m.content})), 
          this.settings.ai
        );
        this.aiState.messages.push({ id: Date.now()+':a', role:'assistant', content: reply });
      } catch (e) {
        this.aiState.messages.push({ 
          id: Date.now()+':a', 
          role:'assistant', 
          content: '调用失败：' + e.message 
        });
      } finally {
        this.aiState.thinking = false;
      }
      
      const max = this.settings.ai.maxTurns || 6;
      this.aiState.messages = this.aiState.messages.slice(-max*2);
    },

    handleMemoryEnter() {
      if (!this.currentCard) return;
      
      if (this.showMeaning) {
        // 当显示释义时，按 Enter 进入下一题
        this.nextCard();
      } else {
        // 当未显示释义时，需要先评分才能显示释义
        if (!this.lastGrade) return;
        this.showMeaning = true;
        // 设置焦点到容器元素
        this.$nextTick(() => {
          const container = document.querySelector('[x-data="vocabApp"] [tabindex="0"]');
          if (container) container.focus();
        });
      }
    },

    // 在 vocabApp 对象中添加方法

    studyOneMoreSet() {
      // 临时增加今日学习配额
      const originalLearned = this.statsToday.learned;
      this.statsToday.learned = Math.max(0, originalLearned - this.settings.daily.newPerDay);
      
      // 重新生成队列
      const enabledIds = new Set(this.decks.filter(d=>d.enabled).map(d=>d.id));
      const merged = {};
      for (const [k, c] of Object.entries(this.cards)) {
        const did = (c._deck?.match(/^\[(.+?)\]/)||[])[1];
        if (!did || enabledIds.has(did)) merged[k]=c;
      }
      
      // 重新构建队列
      const { studyQueue, reviewQueue } = buildQueue(merged, this.settings, this.statsToday);
      this.queue = studyQueue;
      this.currentCard = this.queue.shift() || null;
      
      // 重置学习状态
      this.showMeaning = false;
      this.spellingStudyStage = 'show';
      this.spellingStudyInput = '';
      this.spellingStudyFeedback = '';
      this.lastGrade = null;
      this.currentGradeUI = null;
      
      // 还原统计数据
      this.statsToday.learned = originalLearned;
    },
  }));
});
