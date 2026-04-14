const express = require("express");
const session = require("express-session");
const FileStore = require('session-file-store')(session);
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { Telegraf } = require("telegraf");
const path = require("path");
const fs = require('fs');

const app = express();
const DATA_FILE = './data.json';

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return data;
    }
  } catch(e) {}
  return { users: {}, habits: {}, studies: {}, diaries: {}, telegramUsers: {} };
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users, habits, studies, diaries, telegramUsers }));
  } catch(e) {}
}

const _data = loadData();
let users = _data.users;
let habits = _data.habits;
let studies = _data.studies;
let diaries = _data.diaries;
let telegramUsers = _data.telegramUsers;

function getUser(req) {
  if (req.user) return req.user;
  if (req.session && req.session.telegramUserId) {
    return users[req.session.telegramUserId] || null;
  }
  return null;
}

app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));
app.use(
  session({
    secret: "fikrcha-secret",
    resave: false,
    saveUninitialized: false,
    store: new FileStore({ path: '/tmp/sessions', ttl: 86400 * 30, retries: 0 }),
    cookie: { maxAge: 86400000 * 30 }
  })
);
app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => {
  if (!req.user && req.session && req.session.telegramUserId) {
    req.user = users[req.session.telegramUserId] || null;
  }
  next();
});

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  done(null, users[id] || null);
});

const DOMAIN = process.env.DOMAIN || "https://fikrcha.onrender.com";

app.post('/auth/telegram', (req, res) => {
  const { user } = req.body;
  if (!user || !user.id) return res.json({ success: false });

  const telegramId = String(user.id);

  if (req.user && req.user.id) {
    telegramUsers[telegramId] = req.user.id;
    users[req.user.id].telegramId = telegramId;
    if (user.username) users[req.user.id].telegramUsername = user.username;
    req.session.telegramUserId = req.user.id;
    saveData();
    return res.json({ success: true });
  }

  let userId = telegramUsers[telegramId];

  if (!userId) {
    userId = `tg_${telegramId}`;
    users[userId] = {
      id: userId,
      name: user.first_name + (user.last_name ? ' ' + user.last_name : ''),
      email: '',
      avatar: user.photo_url || '',
      isAdmin: false,
      telegramId,
      telegramUsername: user.username || '',
    };
    habits[userId] = [];
    studies[userId] = [];
    diaries[userId] = [];
    telegramUsers[telegramId] = userId;
    saveData();
  } else {
    // Update username if changed
    if (users[userId] && user.username) {
      users[userId].telegramUsername = user.username;
      saveData();
    }
  }

  req.session.telegramUserId = userId;
  res.json({ success: true });
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${DOMAIN}/auth/google/callback`,
      scope: ["profile", "email"],
    },
    (accessToken, refreshToken, profile, done) => {
      let user = users[profile.id];
      if (!user) {
        user = {
          id: profile.id,
          name: profile.displayName,
          email: profile.emails[0].value,
          avatar: profile.photos[0]?.value || "",
          isAdmin: profile.emails[0].value === process.env.ADMIN_EMAIL,
        };
        users[profile.id] = user;
        habits[profile.id] = [];
        studies[profile.id] = [];
        diaries[profile.id] = [];
        saveData();
      }
      done(null, user);
    },
  ),
);

app.get("/auth/google", (req, res, next) => {
  if (req.query.tgid) req.session.pendingTelegramId = String(req.query.tgid);
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    if (req.session.pendingTelegramId) {
      const tgId = req.session.pendingTelegramId;
      telegramUsers[tgId] = req.user.id;
      users[req.user.id].telegramId = tgId;
      req.session.telegramUserId = req.user.id;
      delete req.session.pendingTelegramId;
      saveData();
    }
    res.redirect("/app.html");
  },
);

app.get("/api/user", (req, res) => {
  const user = getUser(req);
  if (!user) return res.json({ error: "Not logged in" });
  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    avatar: user.avatar,
    isAdmin: user.isAdmin,
    telegramUsername: user.telegramUsername || '',
    telegramId: user.telegramId || ''
  });
});

app.post("/api/link-telegram", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { telegramId, telegramUsername } = req.body;
  if (telegramId) {
    telegramUsers[String(telegramId)] = user.id;
    users[user.id].telegramId = String(telegramId);
    if (telegramUsername) users[user.id].telegramUsername = telegramUsername;
    saveData();
  }
  res.json({ success: true });
});

app.get("/api/force-link/:tgid/:userid", (req, res) => {
  const tgId = req.params.tgid;
  const userId = req.params.userid;
  telegramUsers[tgId] = userId;
  if (users[userId]) users[userId].telegramId = tgId;
  saveData();
  res.json({ success: true, linked: { tgId, userId } });
});

// HABITS
app.get("/api/habits", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json(habits[user.id] || []);
});

// *** FIX: Save schedule field when creating habit ***
app.post("/api/habits", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { name, time, category, schedule } = req.body;
  const newHabit = {
    id: Date.now(),
    name,
    time: time || "",
    category: category || "",
    history: {},
    schedule: schedule || { type: 'daily', days: [], onceDates: [] }
  };
  if (!habits[user.id]) habits[user.id] = [];
  habits[user.id].push(newHabit);
  saveData();
  res.json({ success: true });
});

// *** FIX: Save schedule field when updating habit ***
app.put("/api/habits/:id", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { name, time, category, history, schedule, order } = req.body;
  const habit = (habits[user.id] || []).find((h) => h.id == req.params.id);
  if (habit) {
    if (name !== undefined) habit.name = name;
    if (time !== undefined) habit.time = time;
    if (category !== undefined) habit.category = category;
    if (history !== undefined) habit.history = history;
    if (schedule !== undefined) habit.schedule = schedule;
  }
  saveData();
  res.json({ success: true });
});

app.delete("/api/habits/:id", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  habits[user.id] = (habits[user.id] || []).filter((h) => h.id != req.params.id);
  saveData();
  res.json({ success: true });
});

// *** NEW: Reorder habits endpoint ***
app.post("/api/habits/reorder", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: "orderedIds required" });
  const current = habits[user.id] || [];
  const reordered = [];
  orderedIds.forEach(id => {
    const h = current.find(x => x.id == id);
    if (h) reordered.push(h);
  });
  // Add any habits not in orderedIds at the end
  current.forEach(h => { if (!orderedIds.includes(h.id)) reordered.push(h); });
  habits[user.id] = reordered;
  saveData();
  res.json({ success: true });
});

// STUDIES
app.get("/api/studies", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json(studies[user.id] || []);
});

app.post("/api/studies", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { title } = req.body;
  const newStudy = { id: Date.now(), title, tasks: [] };
  if (!studies[user.id]) studies[user.id] = [];
  studies[user.id].unshift(newStudy);
  saveData();
  res.json({ success: true });
});

app.put("/api/studies/:id", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { title, tasks } = req.body;
  const study = (studies[user.id] || []).find((s) => s.id == req.params.id);
  if (study) {
    if (title !== undefined) study.title = title;
    if (tasks !== undefined) study.tasks = tasks;
  }
  saveData();
  res.json({ success: true });
});

app.delete("/api/studies/:id", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  studies[user.id] = (studies[user.id] || []).filter((s) => s.id != req.params.id);
  saveData();
  res.json({ success: true });
});

// DIARIES
app.get("/api/diaries", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json(diaries[user.id] || []);
});

app.post("/api/diaries", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { date, entry, image, voice } = req.body;
  const newDiary = { id: Date.now(), date, entry, image: image || null, voice: voice || null, time: new Date().toLocaleTimeString() };
  if (!diaries[user.id]) diaries[user.id] = [];
  diaries[user.id].push(newDiary);
  saveData();
  res.json({ success: true });
});

app.put("/api/diaries/:id", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { entry } = req.body;
  const diary = (diaries[user.id] || []).find((d) => d.id == req.params.id);
  if (diary && entry !== undefined) diary.entry = entry;
  saveData();
  res.json({ success: true });
});

app.delete("/api/diaries/:id", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  diaries[user.id] = (diaries[user.id] || []).filter((d) => d.id != req.params.id);
  saveData();
  res.json({ success: true });
});

app.get("/api/admin/users", (req, res) => {
  const user = getUser(req);
  if (!user || !user.isAdmin) return res.status(403).json({ error: "Unauthorized" });
  const allUsers = Object.values(users).map((u) => ({
    id: u.id, name: u.name, email: u.email,
    habits: habits[u.id] || [], studies: studies[u.id] || [], diaries: diaries[u.id] || [],
  }));
  res.json(allUsers);
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/app.html", (req, res) => res.sendFile(path.join(__dirname, "app.html")));
app.get("/admin.html", (req, res) => {
  const user = getUser(req);
  if (!user || !user.isAdmin) return res.redirect("/");
  res.sendFile(path.join(__dirname, "admin.html"));
});

// ===== GROQ AI ROUTE (FREE) =====
app.post('/api/ai-chat', async (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const { message, system, history } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    return res.json({ reply: '⚠️ AI not configured. Add GROQ_API_KEY to Render env vars.' });
  }

  try {
    const messages = [ ...(history || []).slice(-6), { role: 'user', content: message } ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 400,
        messages: [
          { role: 'system', content: system || 'You are FIKRCHA AI, a helpful productivity assistant. Be concise and direct. Max 80 words per response.' },
          ...messages
        ]
      })
    });

    const data = await response.json();
    if (data.choices?.[0]) {
      res.json({ reply: data.choices[0].message.content });
    } else {
      res.json({ reply: '⚠️ AI error. Please try again.' });
    }
  } catch (err) {
    console.error('AI error:', err);
    res.json({ reply: '⚠️ AI temporarily unavailable.' });
  }
});

// ============================================================
// TELEGRAM BOT — IMPROVED VERSION
// Replace everything from line 410 to end of your index.js
// with this code
// ============================================================

const bot = new Telegraf(process.env.BOT_TOKEN);
const webAppUrl = DOMAIN;

// ── helpers ──────────────────────────────────────────────────

function getTodayStr() {
  return new Date().toISOString().split("T")[0];
}

function getRealUserId(userId) {
  if (userId && userId.startsWith('tg_')) {
    const tgId = userId.replace('tg_', '');
    const linked = telegramUsers[tgId];
    if (linked && !linked.startsWith('tg_')) return linked;
  }
  return userId;
}

function getStreak(habit) {
  let streak = 0;
  const d = new Date();
  for (let n = 0; n < 365; n++) {
    const ds = d.toISOString().split("T")[0];
    if (habit.history[ds]) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

function getConsistency30(habit) {
  let scheduled = 0, done = 0;
  for (let i = 0; i < 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().split("T")[0];
    scheduled++;
    if (habit.history[ds]) done++;
  }
  return scheduled === 0 ? 0 : Math.round((done / scheduled) * 100);
}

// ── keyboard builders ─────────────────────────────────────────

function buildHabitKeyboard(userId) {
  const today = getTodayStr();
  const userHabits = habits[userId] || [];
  const keyboard = userHabits.map((h) => [{
    text: `${h.history[today] ? "✅" : "⬜"} ${h.name}${h.time ? " (" + h.time + ")" : ""}`,
    callback_data: `tog_${userId}_${h.id}`,
  }]);
  keyboard.push([{ text: "📊 Progress", callback_data: `prog_${userId}` }]);
  keyboard.push([{ text: "🚀 Open App", web_app: { url: webAppUrl } }]);
  return keyboard;
}

function buildMainMenu() {
  return {
    inline_keyboard: [
      [{ text: "📅 Today's Habits", callback_data: "cmd_habits" }],
      [{ text: "📊 My Progress", callback_data: "cmd_progress" }],
      [{ text: "📔 Write Diary", callback_data: "cmd_diary_prompt" }],
      [{ text: "🚀 Open Full App", web_app: { url: webAppUrl } }],
    ]
  };
}

// ── /start ───────────────────────────────────────────────────

bot.start((ctx) => {
  const name = ctx.from.first_name || "there";
  ctx.replyWithPhoto(
    // A simple gradient placeholder via a public URL — replace with your own image if you want
    { url: "https://via.placeholder.com/800x400/667eea/ffffff?text=FIKRCHA+%E2%9C%A8" },
    {
      caption:
        `✨ *Welcome to FIKRCHA, ${name}!*\n\n` +
        `_think · grow · achieve_\n\n` +
        `I'm your personal productivity assistant 🤖\n\n` +
        `Here's what I can do for you:\n` +
        `📅 Track your daily habits\n` +
        `📔 Save diary entries\n` +
        `📊 Show your weekly progress\n` +
        `⏰ Send you reminders automatically\n` +
        `🌅 Morning check-in every day\n` +
        `🌙 Evening summary at night\n\n` +
        `👇 *Open the app first* to set up your habits, then come back here!`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚀 Open FIKRCHA App", web_app: { url: webAppUrl } }],
          [{ text: "📅 My Habits", callback_data: "cmd_habits" }, { text: "📊 Progress", callback_data: "cmd_progress" }],
        ]
      }
    }
  ).catch(() => {
    // fallback if photo fails
    ctx.reply(
      `✨ *Welcome to FIKRCHA, ${name}!*\n\n` +
      `_think · grow · achieve_\n\n` +
      `I'm your personal productivity assistant 🤖\n\n` +
      `📅 Track habits · 📔 Write diary · 📊 See progress\n` +
      `⏰ I'll send you automatic reminders!\n\n` +
      `👇 Open the app first to set up your habits:`,
      { parse_mode: "Markdown", reply_markup: buildMainMenu() }
    );
  });
});

// ── /habits ──────────────────────────────────────────────────

bot.command("habits", (ctx) => {
  const telegramId = String(ctx.from.id);
  let userId = telegramUsers[telegramId];
  if (!userId) {
    return ctx.reply(
      "👋 *First, open the app to link your account.*\nAfter signing in, come back and try again!",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]] } }
    );
  }
  userId = getRealUserId(userId);
  const userHabits = habits[userId] || [];
  if (userHabits.length === 0) {
    return ctx.reply("You have no habits yet. Open the app to add some!", {
      reply_markup: { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]] }
    });
  }
  const today = getTodayStr();
  const done = userHabits.filter((h) => h.history[today]).length;
  const pct = Math.round((done / userHabits.length) * 100);
  const emoji = pct === 100 ? "🏆" : pct >= 70 ? "🔥" : pct >= 40 ? "💪" : "⚡";
  ctx.reply(
    `${emoji} *Your Habits — ${today}*\n✅ ${done}/${userHabits.length} completed (${pct}%)\n\nTap a habit to check/uncheck it:`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: buildHabitKeyboard(userId) } }
  );
});

// ── /progress ────────────────────────────────────────────────

bot.command("progress", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const userId = getRealUserId(telegramUsers[telegramId]);
  if (!userId) {
    return ctx.reply("👋 Open the app first to link your account!", {
      reply_markup: { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]] }
    });
  }
  const userHabits = habits[userId] || [];
  if (userHabits.length === 0) {
    return ctx.reply("No habits found. Add some in the app first!");
  }
  const today = getTodayStr();
  const todayDone = userHabits.filter((h) => h.history[today]).length;
  const total = userHabits.length;

  let weekStats = "";
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().split("T")[0];
    const done = userHabits.filter((h) => h.history[ds]).length;
    const pct = Math.round((done / total) * 100);
    const bar = pct >= 80 ? "🟢" : pct >= 50 ? "🟡" : "🔴";
    const label = i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" });
    weekStats += `${bar} ${label}: ${done}/${total} (${pct}%)\n`;
  }

  // Streaks
  const streaks = userHabits.map(h => ({ name: h.name, streak: getStreak(h) })).sort((a, b) => b.streak - a.streak);
  const topStreak = streaks[0];
  const avgC = Math.round(userHabits.reduce((s, h) => s + getConsistency30(h), 0) / total);

  await ctx.reply(
    `📊 *Your Weekly Progress*\n\n${weekStats}\n` +
    `💪 Today: ${todayDone}/${total} completed\n` +
    `📈 30-day avg: ${avgC}%\n` +
    (topStreak && topStreak.streak > 0 ? `🔥 Best streak: "${topStreak.name}" — ${topStreak.streak} days` : ''),
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🚀 Open Full App", web_app: { url: webAppUrl } }]] } }
  );
});

// ── /diary ───────────────────────────────────────────────────

bot.command("diary", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const userId = getRealUserId(telegramUsers[telegramId]);
  if (!userId) {
    return ctx.reply("👋 Open the app first to link your account!", {
      reply_markup: { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]] }
    });
  }
  const text = ctx.message.text.replace(/^\/diary\s*/, "").trim();
  if (!text) {
    return ctx.reply(
      "📔 *How to save a diary entry:*\n\nJust type after the command:\n`/diary Today was a great day!`",
      { parse_mode: "Markdown" }
    );
  }
  const today = getTodayStr();
  if (!diaries[userId]) diaries[userId] = [];
  diaries[userId].push({ id: Date.now(), date: today, entry: text, image: null, time: new Date().toLocaleTimeString() });
  saveData();
  await ctx.reply(
    `📔 *Diary saved!* ✨\n\n_"${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"_\n\n📅 ${today}`,
    { parse_mode: "Markdown" }
  );
});

// ── /menu ────────────────────────────────────────────────────

bot.command("menu", (ctx) => {
  ctx.reply("👇 What would you like to do?", { reply_markup: buildMainMenu() });
});

// ── /streak ──────────────────────────────────────────────────

bot.command("streak", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const userId = getRealUserId(telegramUsers[telegramId]);
  if (!userId) return ctx.reply("Open the app first!");
  const userHabits = habits[userId] || [];
  if (!userHabits.length) return ctx.reply("No habits yet. Add some in the app!");

  const lines = userHabits.map(h => {
    const s = getStreak(h);
    const c = getConsistency30(h);
    const fire = s >= 7 ? "🔥" : s >= 3 ? "⭐" : "💧";
    return `${fire} *${h.name}*: ${s} day streak · ${c}% (30d)`;
  }).join("\n");

  await ctx.reply(`🏆 *Your Streaks*\n\n${lines}`, { parse_mode: "Markdown" });
});

// ── callback_query handler ────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // ── cmd shortcuts ──
  if (data === "cmd_habits") {
    const telegramId = String(ctx.from.id);
    let userId = telegramUsers[telegramId];
    if (!userId) return ctx.answerCbQuery("Open the app first to link your account!");
    userId = getRealUserId(userId);
    const userHabits = habits[userId] || [];
    if (!userHabits.length) return ctx.answerCbQuery("No habits yet. Add in the app!");
    const today = getTodayStr();
    const done = userHabits.filter(h => h.history[today]).length;
    await ctx.answerCbQuery();
    return ctx.reply(
      `📅 *Habits — ${today}*\n✅ ${done}/${userHabits.length} done\n\nTap to check:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: buildHabitKeyboard(userId) } }
    );
  }

  if (data === "cmd_progress") {
    await ctx.answerCbQuery();
    ctx.message = { text: "/progress" };
    const telegramId = String(ctx.from.id);
    const userId = getRealUserId(telegramUsers[telegramId]);
    if (!userId) return ctx.reply("Open the app first!");
    const userHabits = habits[userId] || [];
    const today = getTodayStr();
    const total = userHabits.length;
    const todayDone = userHabits.filter(h => h.history[today]).length;
    let weekStats = "";
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split("T")[0];
      const done = userHabits.filter(h => h.history[ds]).length;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const bar = pct >= 80 ? "🟢" : pct >= 50 ? "🟡" : "🔴";
      const label = i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" });
      weekStats += `${bar} ${label}: ${done}/${total} (${pct}%)\n`;
    }
    return ctx.reply(
      `📊 *Weekly Progress*\n\n${weekStats}\n💪 Today: ${todayDone}/${total}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]] } }
    );
  }

  if (data === "cmd_diary_prompt") {
    await ctx.answerCbQuery();
    return ctx.reply("📔 Send me your diary entry like this:\n\n`/diary Your text here...`", { parse_mode: "Markdown" });
  }

  // ── habit toggle ──
  if (data.startsWith("tog_")) {
    const parts = data.split("_");
    const habitId = parseInt(parts[parts.length - 1]);
    const userId = parts.slice(1, parts.length - 1).join("_");
    const today = getTodayStr();
    const userHabits = habits[userId] || [];
    const habit = userHabits.find((h) => h.id === habitId);
    if (!habit) return ctx.answerCbQuery("Habit not found");
    habit.history[today] = !habit.history[today];
    saveData();
    const status = habit.history[today] ? "✅ Done" : "⬜ Unchecked";
    const done = userHabits.filter((h) => h.history[today]).length;
    const pct = Math.round((done / userHabits.length) * 100);
    const emoji = pct === 100 ? "🏆" : pct >= 70 ? "🔥" : pct >= 40 ? "💪" : "⚡";
    await ctx.editMessageText(
      `${emoji} *Your Habits — ${today}*\n✅ ${done}/${userHabits.length} completed (${pct}%)\n\nTap a habit to check/uncheck it:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: buildHabitKeyboard(userId) } }
    );
    // If all done — celebrate!
    if (done === userHabits.length) {
      await ctx.answerCbQuery("🏆 ALL DONE! Amazing work today!", { show_alert: true });
    } else {
      await ctx.answerCbQuery(`${status}: ${habit.name}`);
    }
    return;
  }

  // ── progress popup ──
  if (data.startsWith("prog_")) {
    const userId = data.slice(5);
    const userHabits = habits[userId] || [];
    const today = getTodayStr();
    const done = userHabits.filter((h) => h.history[today]).length;
    const total = userHabits.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const emoji = pct === 100 ? "🏆" : pct >= 80 ? "🔥" : pct >= 50 ? "💪" : "⚡";
    let weekStats = "";
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds = d.toISOString().split("T")[0];
      const dayDone = userHabits.filter(h => h.history[ds]).length;
      const dayPct = total > 0 ? Math.round((dayDone / total) * 100) : 0;
      const bar = dayPct >= 80 ? "🟢" : dayPct >= 50 ? "🟡" : "🔴";
      const label = i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" });
      weekStats += `${bar} ${label}: ${dayDone}/${total} (${dayPct}%)\n`;
    }
    await ctx.answerCbQuery(`${emoji} Today: ${done}/${total} (${pct}%)`, { show_alert: true });
    await ctx.reply(`📊 *This week:*\n\n${weekStats}`, { parse_mode: "Markdown" });
    return;
  }
});

// ── SCHEDULED NOTIFICATIONS ───────────────────────────────────
// Runs every 60 seconds and handles:
//   1. Morning reminder at 08:00
//   2. Evening summary at 21:00
//   3. 1-minute-before habit reminders
//   4. Streak milestone alerts (sent once per day)

const sentMorning = new Set();    // track who got morning msg today
const sentEvening = new Set();    // track who got evening msg today
const sentStreaks  = new Set();   // track streak alerts sent today

setInterval(() => {
  const now     = new Date();
  const hour    = now.getHours();
  const minute  = now.getMinutes();
  const todayStr = getTodayStr();

  // Reset sets at midnight
  if (hour === 0 && minute === 0) {
    sentMorning.clear();
    sentEvening.clear();
    sentStreaks.clear();
  }

  Object.entries(telegramUsers).forEach(([telegramId, userId]) => {
    const realId    = getRealUserId(userId);
    const userHabits = habits[realId] || [];
    if (!userHabits.length) return;

    const name = users[realId]?.name?.split(" ")[0] || "there";
    const total = userHabits.length;
    const done  = userHabits.filter(h => h.history[todayStr]).length;

    // ── 1. Morning reminder at 08:00 ──────────────────────────
    if (hour === 8 && minute === 0 && !sentMorning.has(telegramId)) {
      sentMorning.add(telegramId);
      bot.telegram.sendMessage(
        telegramId,
        `🌅 *Good morning, ${name}!*\n\n` +
        `You have *${total} habit${total > 1 ? 's' : ''}* today.\n` +
        `Let's start strong 💪\n\nTap to check them off:`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: buildHabitKeyboard(realId) }
        }
      ).catch(() => {});
    }

    // ── 2. Evening summary at 21:00 ───────────────────────────
    if (hour === 21 && minute === 0 && !sentEvening.has(telegramId)) {
      sentEvening.add(telegramId);
      const pct   = Math.round((done / total) * 100);
      const emoji = pct === 100 ? "🏆" : pct >= 70 ? "🔥" : pct >= 40 ? "😊" : "💪";
      const msg =
        pct === 100
          ? `${emoji} *Perfect day, ${name}!*\n\nYou completed ALL ${total} habits today! 🎉\nKeep this energy tomorrow!`
          : pct >= 70
          ? `${emoji} *Great job, ${name}!*\n\n${done}/${total} habits done (${pct}%) — almost there!\nDon't forget the remaining ${total - done}.`
          : `${emoji} *Evening check-in, ${name}*\n\n${done}/${total} habits done today (${pct}%).\nTomorrow is a new chance — you've got this! 💪`;

      bot.telegram.sendMessage(telegramId, msg, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [
          [{ text: "✅ Check remaining habits", callback_data: `cmd_habits` }],
          [{ text: "🚀 Open App", web_app: { url: webAppUrl } }]
        ]}
      }).catch(() => {});
    }

    // ── 3. 1-minute-before habit reminders ───────────────────
    const oneMinLater = new Date(now.getTime() + 60 * 1000);
    const targetTime  = `${String(oneMinLater.getHours()).padStart(2,'0')}:${String(oneMinLater.getMinutes()).padStart(2,'0')}`;

    userHabits.forEach(habit => {
      if (!habit.time || habit.history[todayStr]) return;
      if (habit.time !== targetTime) return;
      const notifKey = `${todayStr}_${telegramId}_${habit.id}`;
      if (sentStreaks.has(notifKey)) return; // reuse set to avoid duplicates
      sentStreaks.add(notifKey);
      bot.telegram.sendMessage(
        telegramId,
        `⏰ *1 minute reminder!*\n\n📌 *${habit.name}* starts at ${habit.time}\n\nGet ready, ${name}! 💪`,
        {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [
            [{ text: `⬜ ${habit.name} — Mark done`, callback_data: `tog_${realId}_${habit.id}` }],
            [{ text: "🚀 Open App", web_app: { url: webAppUrl } }]
          ]}
        }
      ).catch(() => {});
    });

    // ── 4. Streak milestone alert (once per day at 20:00) ────
    if (hour === 20 && minute === 0) {
      userHabits.forEach(habit => {
        const streak = getStreak(habit);
        const milestones = [3, 7, 14, 21, 30, 60, 100];
        if (!milestones.includes(streak)) return;
        const key = `streak_${todayStr}_${telegramId}_${habit.id}`;
        if (sentStreaks.has(key)) return;
        sentStreaks.add(key);
        bot.telegram.sendMessage(
          telegramId,
          `🔥 *${streak}-Day Streak!*\n\n` +
          `You've done "*${habit.name}*" for ${streak} days in a row, ${name}!\n\n` +
          `${streak >= 30 ? "🏆 Incredible dedication!" : streak >= 14 ? "⭐ You're building a real habit!" : "💪 Keep it going!"}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      });
    }
  });

}, 60000); // every 60 seconds

// ── launch ────────────────────────────────────────────────────

bot.launch({ allowedUpdates: [], dropPendingUpdates: true });
console.log("🤖 Bot is running!");

const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web app running on port ${PORT}`);
  console.log(`🔗 URL: https://fikrcha.onrender.com`);
});
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;
