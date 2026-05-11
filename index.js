const express = require("express");
const session = require("express-session");
const FileStore = require('session-file-store')(session);
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { Telegraf } = require("telegraf");
const path = require("path");
const mongoose = require("mongoose");

// ── MongoDB ───────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// ── Schemas ───────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  _id: String,
  name: String,
  email: String,
  avatar: String,
  isAdmin: Boolean,
  telegramId: String,
  telegramUsername: String,
});
const HabitSchema = new mongoose.Schema({
  userId: String,
  id: Number,
  name: String,
  time: String,
  category: String,
  history: { type: mongoose.Schema.Types.Mixed, default: {} },
  schedule: { type: mongoose.Schema.Types.Mixed, default: { type: 'daily', days: [], onceDates: [] } },
});
const StudySchema = new mongoose.Schema({
  userId: String,
  id: Number,
  title: String,
  tasks: { type: mongoose.Schema.Types.Mixed, default: [] },
});
const DiarySchema = new mongoose.Schema({
  userId: String,
  id: Number,
  date: String,
  entry: String,
  image: String,
  voice: String,
  time: String,
});
const TelegramLinkSchema = new mongoose.Schema({
  _id: String,
  userId: String,
});

const User         = mongoose.model("User", UserSchema);
const Habit        = mongoose.model("Habit", HabitSchema);
const Study        = mongoose.model("Study", StudySchema);
const Diary        = mongoose.model("Diary", DiarySchema);
const TelegramLink = mongoose.model("TelegramLink", TelegramLinkSchema);

// ── Express ───────────────────────────────────────────────────
const app    = express();
const DOMAIN = process.env.DOMAIN || "https://fikrcha.onrender.com";

app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));
app.use(session({
  secret: "fikrcha-secret",
  resave: false,
  saveUninitialized: false,
  store: new FileStore({ path: '/tmp/sessions', ttl: 86400 * 30, retries: 0 }),
  cookie: { maxAge: 86400000 * 30 }
}));
app.use(passport.initialize());
app.use(passport.session());

// ── Helpers ───────────────────────────────────────────────────
function getTodayStr() {
  return new Date().toISOString().split("T")[0];
}

async function getUser(req) {
  if (req.user) return req.user;
  if (req.session?.telegramUserId) {
    return await User.findById(req.session.telegramUserId).lean() || null;
  }
  return null;
}

async function getRealUserId(userId) {
  if (userId?.startsWith('tg_')) {
    const tgId = userId.replace('tg_', '');
    const link = await TelegramLink.findById(tgId).lean();
    if (link && !link.userId.startsWith('tg_')) return link.userId;
  }
  return userId;
}

function getStreak(habit) {
  let streak = 0;
  const d = new Date();
  for (let n = 0; n < 365; n++) {
    const ds = d.toISOString().split("T")[0];
    if (habit?.history?.[ds]) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

function getConsistency30(habit) {
  let done = 0;
  for (let i = 0; i < 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    if (habit?.history?.[d.toISOString().split("T")[0]]) done++;
  }
  return Math.round((done / 30) * 100);
}

// ── AI helper — Groq bilan 8 sekund timeout ───────────────────
// Agar Groq 8 sekund ichida javob bermasa, xato qaytaradi
async function callGroq(messages, maxTokens = 200) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000); // 8 sekund
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0.4,
        max_tokens: maxTokens,
        messages
      }),
      signal: controller.signal
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    if (err.name === 'AbortError') return null; // timeout
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Passport ──────────────────────────────────────────────────
passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try { done(null, await User.findById(id).lean()); }
  catch (e) { done(e, null); }
});

passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  `${DOMAIN}/auth/google/callback`,
    scope: ["profile", "email"],
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await User.findById(profile.id).lean();
      if (!user) {
        user = (await User.create({
          _id:     profile.id,
          name:    profile.displayName,
          email:   profile.emails[0].value,
          avatar:  profile.photos[0]?.value || "",
          isAdmin: profile.emails[0].value === process.env.ADMIN_EMAIL,
        })).toObject();
      }
      done(null, user);
    } catch (e) { done(e, null); }
  }
));

app.use(async (req, res, next) => {
  if (!req.user && req.session?.telegramUserId) {
    req.user = await User.findById(req.session.telegramUserId).lean() || null;
  }
  next();
});

// ── Auth ──────────────────────────────────────────────────────
app.post('/auth/telegram', async (req, res) => {
  const { user } = req.body;
  if (!user?.id) return res.json({ success: false });
  const telegramId = String(user.id);

  if (req.user?._id) {
    await TelegramLink.findByIdAndUpdate(telegramId, { userId: req.user._id }, { upsert: true });
    await User.findByIdAndUpdate(req.user._id, { telegramId, telegramUsername: user.username || req.user.telegramUsername });
    req.session.telegramUserId = req.user._id;
    return res.json({ success: true });
  }

  let link = await TelegramLink.findById(telegramId).lean();
  let userId;
  if (!link) {
    userId = `tg_${telegramId}`;
    await User.findByIdAndUpdate(userId, {
      _id: userId,
      name: user.first_name + (user.last_name ? ' ' + user.last_name : ''),
      email: '', avatar: user.photo_url || '', isAdmin: false,
      telegramId, telegramUsername: user.username || '',
    }, { upsert: true });
    await TelegramLink.findByIdAndUpdate(telegramId, { userId }, { upsert: true });
  } else {
    userId = link.userId;
    if (user.username) await User.findByIdAndUpdate(userId, { telegramUsername: user.username });
  }
  req.session.telegramUserId = userId;
  res.json({ success: true });
});

app.get("/auth/google", (req, res, next) => {
  if (req.query.tgid) req.session.pendingTelegramId = String(req.query.tgid);
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  async (req, res) => {
    if (req.session.pendingTelegramId) {
      const tgId = req.session.pendingTelegramId;
      await TelegramLink.findByIdAndUpdate(tgId, { userId: req.user._id }, { upsert: true });
      await User.findByIdAndUpdate(req.user._id, { telegramId: tgId });
      req.session.telegramUserId = req.user._id;
      delete req.session.pendingTelegramId;
    }
    res.redirect("/app.html");
  }
);

// ── User API ──────────────────────────────────────────────────
app.get("/api/user", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.json({ error: "Not logged in" });
  res.json({ id: user._id, name: user.name, email: user.email, avatar: user.avatar,
    isAdmin: user.isAdmin, telegramUsername: user.telegramUsername || '', telegramId: user.telegramId || '' });
});

app.post("/api/link-telegram", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { telegramId, telegramUsername } = req.body;
  if (telegramId) {
    await TelegramLink.findByIdAndUpdate(String(telegramId), { userId: user._id }, { upsert: true });
    await User.findByIdAndUpdate(user._id, { telegramId: String(telegramId), ...(telegramUsername ? { telegramUsername } : {}) });
  }
  res.json({ success: true });
});

app.get("/api/force-link/:tgid/:userid", async (req, res) => {
  await TelegramLink.findByIdAndUpdate(req.params.tgid, { userId: req.params.userid }, { upsert: true });
  await User.findByIdAndUpdate(req.params.userid, { telegramId: req.params.tgid });
  res.json({ success: true });
});

// ── Habits ────────────────────────────────────────────────────
app.get("/api/habits", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json(await Habit.find({ userId: user._id }).lean());
});

app.post("/api/habits", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { name, time, category, schedule } = req.body;
  await Habit.create({ userId: user._id, id: Date.now(), name, time: time || "",
    category: category || "", history: {}, schedule: schedule || { type: 'daily', days: [], onceDates: [] } });
  res.json({ success: true });
});

app.put("/api/habits/:id", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { name, time, category, history, schedule } = req.body;
  const update = {};
  if (name !== undefined)     update.name = name;
  if (time !== undefined)     update.time = time;
  if (category !== undefined) update.category = category;
  if (history !== undefined)  update.history = history;
  if (schedule !== undefined) update.schedule = schedule;
  await Habit.findOneAndUpdate({ userId: user._id, id: Number(req.params.id) }, update);
  res.json({ success: true });
});

app.delete("/api/habits/:id", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  await Habit.findOneAndDelete({ userId: user._id, id: Number(req.params.id) });
  res.json({ success: true });
});

app.post("/api/habits/reorder", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json({ success: true });
});

// ── Studies ───────────────────────────────────────────────────
app.get("/api/studies", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json(await Study.find({ userId: user._id }).lean());
});

app.post("/api/studies", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  await Study.create({ userId: user._id, id: Date.now(), title: req.body.title, tasks: [] });
  res.json({ success: true });
});

app.put("/api/studies/:id", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const update = {};
  if (req.body.title !== undefined) update.title = req.body.title;
  if (req.body.tasks !== undefined) update.tasks = req.body.tasks;
  await Study.findOneAndUpdate({ userId: user._id, id: Number(req.params.id) }, update);
  res.json({ success: true });
});

app.delete("/api/studies/:id", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  await Study.findOneAndDelete({ userId: user._id, id: Number(req.params.id) });
  res.json({ success: true });
});

// ── Diaries ───────────────────────────────────────────────────
app.get("/api/diaries", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json(await Diary.find({ userId: user._id }).lean());
});

app.post("/api/diaries", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { date, entry, image, voice } = req.body;
  await Diary.create({ userId: user._id, id: Date.now(), date, entry,
    image: image || null, voice: voice || null, time: new Date().toLocaleTimeString() });
  res.json({ success: true });
});

app.put("/api/diaries/:id", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  if (req.body.entry !== undefined)
    await Diary.findOneAndUpdate({ userId: user._id, id: Number(req.params.id) }, { entry: req.body.entry });
  res.json({ success: true });
});

app.delete("/api/diaries/:id", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  await Diary.findOneAndDelete({ userId: user._id, id: Number(req.params.id) });
  res.json({ success: true });
});

// ── Admin ─────────────────────────────────────────────────────
app.get("/api/admin/users", async (req, res) => {
  const user = await getUser(req);
  if (!user?.isAdmin) return res.status(403).json({ error: "Unauthorized" });
  const allUsers = await User.find().lean();
  res.json(await Promise.all(allUsers.map(async u => ({
    id: u._id, name: u.name, email: u.email,
    habits:  await Habit.find({ userId: u._id }).lean(),
    studies: await Study.find({ userId: u._id }).lean(),
    diaries: await Diary.find({ userId: u._id }).lean(),
  }))));
});

app.delete("/api/admin/users/:id", async (req, res) => {
  const user = await getUser(req);
  if (!user?.isAdmin) return res.status(403).json({ error: "Unauthorized" });
  const id = req.params.id;
  await User.findByIdAndDelete(id);
  await Habit.deleteMany({ userId: id });
  await Study.deleteMany({ userId: id });
  await Diary.deleteMany({ userId: id });
  res.json({ success: true });
});

// ── Pages ─────────────────────────────────────────────────────
// /ping — cron-job.org uchun, kichkina javob qaytaradi
app.get("/ping", (req, res) => res.send("ok"));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/app.html", (req, res) => res.sendFile(path.join(__dirname, "app.html")));
app.get("/admin.html", async (req, res) => {
  const user = await getUser(req);
  if (!user?.isAdmin) return res.redirect("/");
  res.sendFile(path.join(__dirname, "admin.html"));
});

// ── AI Chat ───────────────────────────────────────────────────
// Muammo: Groq ba'zan 30-40 sekund kutardi. Endi 8 sekund timeout bor.
// Agar javob kelmasa — darhol xato qaytaradi, foydalanuvchi kutmaydi.
app.post('/api/ai-chat', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const { message, system, history } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  if (!process.env.GROQ_API_KEY)
    return res.json({ reply: '⚠️ AI not configured. Add GROQ_API_KEY to Render env vars.' });

  try {
    const today = getTodayStr();
    const habits = await Habit.find({ userId: user._id }).lean();
    const done   = habits.filter(h => h?.history?.[today]).length;
    const total  = habits.length;

    const systemPrompt = system || `You are FIKRCHA AI, a productivity coach.
User stats today: ${done}/${total} habits done.
Rules: Reply in SAME language as the user. Max 3 sentences. Be direct and helpful.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).slice(-6),
      { role: 'user', content: message }
    ];

    const reply = await callGroq(messages, 250);

    if (reply) {
      res.json({ reply });
    } else {
      // Groq timeout — tez javob
      res.json({ reply: '⚠️ AI is slow right now. Please try again in a moment.' });
    }
  } catch (err) {
    console.error('AI error:', err);
    res.json({ reply: '⚠️ AI temporarily unavailable.' });
  }
});

// ── Telegram Bot ──────────────────────────────────────────────
const bot       = new Telegraf(process.env.BOT_TOKEN);
const webAppUrl = DOMAIN;

async function buildHabitKeyboard(userId) {
  const today    = getTodayStr();
  const userHabits = await Habit.find({ userId }).lean();
  const keyboard = userHabits.map(h => [{
    text: `${h?.history?.[today] ? "✅" : "⬜"} ${h.name}${h.time ? " (" + h.time + ")" : ""}`,
    callback_data: `tog_${userId}_${h.id}`,
  }]);
  keyboard.push([{ text: "📊 Progress", callback_data: `prog_${userId}` }]);
  keyboard.push([{ text: "🚀 Open App", web_app: { url: webAppUrl } }]);
  return keyboard;
}

function buildMainMenu() {
  return { inline_keyboard: [
    [{ text: "📅 Today's Habits",  callback_data: "cmd_habits"       }],
    [{ text: "📊 My Progress",     callback_data: "cmd_progress"     }],
    [{ text: "📔 Write Diary",     callback_data: "cmd_diary_prompt" }],
    [{ text: "🚀 Open Full App",   web_app: { url: webAppUrl }       }],
  ]};
}

// AI coach xabar — bot ichida ishlatiladi, 5 sekund timeout
async function generateCoachMessage(userId, timeOfDay) {
  if (!process.env.GROQ_API_KEY) return null;
  const habits = await Habit.find({ userId }).lean();
  if (!habits.length) return null;
  const today = getTodayStr();
  const done  = habits.filter(h => h?.history?.[today]).length;
  const total = habits.length;
  const prompt = `You are a productivity coach. User done ${done}/${total} habits. Time: ${timeOfDay}. Give 1 short motivational sentence (max 15 words). No emojis in text.`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.1-8b-instant', max_tokens: 60, messages: [{ role: 'user', content: prompt }] }),
      signal: controller.signal
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

bot.start((ctx) => {
  const name = ctx.from.first_name || "there";
  ctx.reply(
    `✨ *Welcome to FIKRCHA, ${name}!*\n\n_think · grow · achieve_\n\n` +
    `I'm your personal productivity assistant 🤖\n\n` +
    `📅 Track your daily habits\n📔 Save diary entries\n📊 Show your weekly progress\n⏰ Automatic reminders\n\n` +
    `👇 *Open the app first* to set up your habits!`,
    { parse_mode: "Markdown", reply_markup: buildMainMenu() }
  );
});

bot.command("habits", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const link = await TelegramLink.findById(telegramId).lean();
  if (!link) return ctx.reply("👋 *First, open the app to link your account.*", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]] }
  });
  const userId    = await getRealUserId(link.userId);
  const userHabits = await Habit.find({ userId }).lean();
  if (!userHabits.length) return ctx.reply("You have no habits yet. Open the app to add some!", {
    reply_markup: { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]] }
  });
  const today = getTodayStr();
  const done  = userHabits.filter(h => h?.history?.[today]).length;
  const pct   = Math.round((done / userHabits.length) * 100);
  const emoji = pct === 100 ? "🏆" : pct >= 70 ? "🔥" : pct >= 40 ? "💪" : "⚡";
  ctx.reply(`${emoji} *Your Habits — ${today}*\n✅ ${done}/${userHabits.length} completed (${pct}%)\n\nTap a habit to check/uncheck it:`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: await buildHabitKeyboard(userId) } });
});

bot.command("progress", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const link = await TelegramLink.findById(telegramId).lean();
  if (!link) return ctx.reply("👋 Open the app first!", {
    reply_markup: { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]] }
  });
  const userId    = await getRealUserId(link.userId);
  const userHabits = await Habit.find({ userId }).lean();
  if (!userHabits.length) return ctx.reply("No habits found. Add some in the app first!");
  const today = getTodayStr();
  const total = userHabits.length;
  const todayDone = userHabits.filter(h => h?.history?.[today]).length;
  let weekStats = "";
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds   = d.toISOString().split("T")[0];
    const done = userHabits.filter(h => h?.history?.[ds]).length;
    const pct  = Math.round((done / total) * 100);
    const bar  = pct >= 80 ? "🟢" : pct >= 50 ? "🟡" : "🔴";
    const label = i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" });
    weekStats += `${bar} ${label}: ${done}/${total} (${pct}%)\n`;
  }
  const topStreak = userHabits.map(h => ({ name: h.name, streak: getStreak(h) })).sort((a,b) => b.streak - a.streak)[0];
  const avgC = Math.round(userHabits.reduce((s, h) => s + getConsistency30(h), 0) / total);
  await ctx.reply(
    `📊 *Your Weekly Progress*\n\n${weekStats}\n💪 Today: ${todayDone}/${total}\n📈 30-day avg: ${avgC}%\n` +
    (topStreak?.streak > 0 ? `🔥 Best streak: "${topStreak.name}" — ${topStreak.streak} days` : ''),
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🚀 Open Full App", web_app: { url: webAppUrl } }]] } }
  );
});

bot.command("diary", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const link = await TelegramLink.findById(telegramId).lean();
  if (!link) return ctx.reply("👋 Open the app first!", {
    reply_markup: { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]] }
  });
  const userId = await getRealUserId(link.userId);
  const text   = ctx.message.text.replace(/^\/diary\s*/, "").trim();
  if (!text) return ctx.reply("📔 *How to save a diary entry:*\n\n`/diary Today was a great day!`", { parse_mode: "Markdown" });
  const today = getTodayStr();
  await Diary.create({ userId, id: Date.now(), date: today, entry: text, image: null, time: new Date().toLocaleTimeString() });
  await ctx.reply(`📔 *Diary saved!* ✨\n\n_"${text.slice(0,100)}${text.length>100?'...':''}"_\n\n📅 ${today}`, { parse_mode: "Markdown" });
});

bot.command("menu",   (ctx) => ctx.reply("👇 What would you like to do?", { reply_markup: buildMainMenu() }));

bot.command("streak", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const link = await TelegramLink.findById(telegramId).lean();
  if (!link) return ctx.reply("Open the app first!");
  const userId    = await getRealUserId(link.userId);
  const userHabits = await Habit.find({ userId }).lean();
  if (!userHabits.length) return ctx.reply("No habits yet. Add some in the app!");
  const lines = userHabits.map(h => {
    const s = getStreak(h), c = getConsistency30(h);
    return `${s>=7?"🔥":s>=3?"⭐":"💧"} *${h.name}*: ${s} day streak · ${c}% (30d)`;
  }).join("\n");
  await ctx.reply(`🏆 *Your Streaks*\n\n${lines}`, { parse_mode: "Markdown" });
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data === "cmd_habits") {
    const telegramId = String(ctx.from.id);
    const link = await TelegramLink.findById(telegramId).lean();
    if (!link) return ctx.answerCbQuery("Open the app first!");
    const userId    = await getRealUserId(link.userId);
    const userHabits = await Habit.find({ userId }).lean();
    if (!userHabits.length) return ctx.answerCbQuery("No habits yet. Add in the app!");
    const today = getTodayStr();
    const done  = userHabits.filter(h => h?.history?.[today]).length;
    await ctx.answerCbQuery();
    return ctx.reply(`📅 *Habits — ${today}*\n✅ ${done}/${userHabits.length} done\n\nTap to check:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: await buildHabitKeyboard(userId) } });
  }

  if (data === "cmd_progress") {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from.id);
    const link = await TelegramLink.findById(telegramId).lean();
    if (!link) return ctx.reply("Open the app first!");
    const userId    = await getRealUserId(link.userId);
    const userHabits = await Habit.find({ userId }).lean();
    const today = getTodayStr();
    const total = userHabits.length;
    const todayDone = userHabits.filter(h => h?.history?.[today]).length;
    let weekStats = "";
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds   = d.toISOString().split("T")[0];
      const done = userHabits.filter(h => h?.history?.[ds]).length;
      const pct  = total > 0 ? Math.round((done / total) * 100) : 0;
      const bar  = pct >= 80 ? "🟢" : pct >= 50 ? "🟡" : "🔴";
      const label = i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" });
      weekStats += `${bar} ${label}: ${done}/${total} (${pct}%)\n`;
    }
    return ctx.reply(`📊 *Weekly Progress*\n\n${weekStats}\n💪 Today: ${todayDone}/${total}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]] } });
  }

  if (data === "cmd_diary_prompt") {
    await ctx.answerCbQuery();
    return ctx.reply("📔 Send me your diary entry like this:\n\n`/diary Your text here...`", { parse_mode: "Markdown" });
  }

  if (data.startsWith("tog_")) {
    const parts   = data.split("_");
    const habitId = parseInt(parts[parts.length - 1]);
    const userId  = parts.slice(1, parts.length - 1).join("_");
    const today   = getTodayStr();
    const habit   = await Habit.findOne({ userId, id: habitId });
    if (!habit) return ctx.answerCbQuery("Habit not found");
    habit.history[today] = !habit.history[today];
    habit.markModified('history');
    await habit.save();
    const userHabits = await Habit.find({ userId }).lean();
    const done  = userHabits.filter(h => h?.history?.[today]).length;
    const pct   = Math.round((done / userHabits.length) * 100);
    const emoji = pct === 100 ? "🏆" : pct >= 70 ? "🔥" : pct >= 40 ? "💪" : "⚡";
    await ctx.editMessageText(
      `${emoji} *Your Habits — ${today}*\n✅ ${done}/${userHabits.length} completed (${pct}%)\n\nTap a habit to check/uncheck it:`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: await buildHabitKeyboard(userId) } }
    );
    if (done === userHabits.length) await ctx.answerCbQuery("🏆 ALL DONE! Amazing work today!", { show_alert: true });
    else await ctx.answerCbQuery(`${habit.history[today] ? "✅ Done" : "⬜ Unchecked"}: ${habit.name}`);
    return;
  }

  if (data.startsWith("prog_")) {
    const userId    = data.slice(5);
    const userHabits = await Habit.find({ userId }).lean();
    const today = getTodayStr();
    const done  = userHabits.filter(h => h?.history?.[today]).length;
    const total = userHabits.length;
    const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
    const emoji = pct === 100 ? "🏆" : pct >= 80 ? "🔥" : pct >= 50 ? "💪" : "⚡";
    let weekStats = "";
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds     = d.toISOString().split("T")[0];
      const dayDone = userHabits.filter(h => h?.history?.[ds]).length;
      const dayPct  = total > 0 ? Math.round((dayDone / total) * 100) : 0;
      const bar     = dayPct >= 80 ? "🟢" : dayPct >= 50 ? "🟡" : "🔴";
      const label   = i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" });
      weekStats += `${bar} ${label}: ${dayDone}/${total} (${dayPct}%)\n`;
    }
    await ctx.answerCbQuery(`${emoji} Today: ${done}/${total} (${pct}%)`, { show_alert: true });
    await ctx.reply(`📊 *This week:*\n\n${weekStats}`, { parse_mode: "Markdown" });
    return;
  }
});

// ── Scheduled notifications ───────────────────────────────────
const sentMorning = new Set();
const sentEvening = new Set();
const sentStreaks  = new Set();

setInterval(async () => {
  const now      = new Date();
  const hour     = now.getHours();
  const minute   = now.getMinutes();
  const todayStr = getTodayStr();

  if (hour === 0 && minute === 0) { sentMorning.clear(); sentEvening.clear(); sentStreaks.clear(); }

  let allLinks;
  try { allLinks = await TelegramLink.find().lean(); }
  catch { return; }

  for (const link of allLinks) {
    const telegramId = link._id;
    const userId     = await getRealUserId(link.userId);
    const userHabits = await Habit.find({ userId }).lean();
    if (!userHabits.length) continue;

    const userDoc = await User.findById(userId).lean();
    const name    = userDoc?.name?.split(" ")[0] || "there";
    const total   = userHabits.length;
    const done    = userHabits.filter(h => h?.history?.[todayStr]).length;

    // 08:00 — ertalab
    if (hour === 8 && minute === 0 && !sentMorning.has(telegramId)) {
      sentMorning.add(telegramId);
      // AI coach xabar (agar GROQ_API_KEY bo'lsa)
      const aiMsg = await generateCoachMessage(userId, "morning").catch(() => null);
      bot.telegram.sendMessage(telegramId,
        `🌅 *Good morning, ${name}!*\n\nYou have *${total} habit${total>1?'s':''}* today.\n${aiMsg ? `\n💬 _${aiMsg}_\n` : ''}Let's start strong 💪`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: await buildHabitKeyboard(userId) } }
      ).catch(() => {});
    }

    // 16:00 — kunduzi hech narsa qilinmagan bo'lsa
    if (hour === 16 && minute === 0 && done === 0) {
      const notifKey = `afternoon_${todayStr}_${telegramId}`;
      if (!sentStreaks.has(notifKey)) {
        sentStreaks.add(notifKey);
        bot.telegram.sendMessage(telegramId,
          `⚠️ *Hey ${name}!*\n\nYou haven't completed any habits today.\nThere's still time — let's go! 💪`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: await buildHabitKeyboard(userId) } }
        ).catch(() => {});
      }
    }

    // 21:00 — kechqurun
    if (hour === 21 && minute === 0 && !sentEvening.has(telegramId)) {
      sentEvening.add(telegramId);
      const pct   = Math.round((done / total) * 100);
      const emoji = pct === 100 ? "🏆" : pct >= 70 ? "🔥" : pct >= 40 ? "😊" : "💪";
      const aiMsg = await generateCoachMessage(userId, "evening").catch(() => null);
      const msg   = pct === 100
        ? `${emoji} *Perfect day, ${name}!*\n\nAll ${total} habits done! 🎉\n${aiMsg ? `\n💬 _${aiMsg}_` : ''}`
        : pct >= 70
        ? `${emoji} *Great job, ${name}!*\n\n${done}/${total} done (${pct}%) — almost!\n${aiMsg ? `\n💬 _${aiMsg}_` : ''}`
        : `${emoji} *Evening check-in, ${name}*\n\n${done}/${total} done (${pct}%).\n${aiMsg ? `\n💬 _${aiMsg}_` : '\nTomorrow is a new chance! 💪'}`;
      bot.telegram.sendMessage(telegramId, msg, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [
          [{ text: "✅ Check remaining habits", callback_data: "cmd_habits" }],
          [{ text: "🚀 Open App", web_app: { url: webAppUrl } }]
        ]}
      }).catch(() => {});
    }

    // 1 daqiqa oldin eslatma
    const oneMinLater = new Date(now.getTime() + 60000);
    const targetTime  = `${String(oneMinLater.getHours()).padStart(2,'0')}:${String(oneMinLater.getMinutes()).padStart(2,'0')}`;
    for (const habit of userHabits) {
      if (!habit.time || habit?.history?.[todayStr] || habit.time !== targetTime) continue;
      const notifKey = `${todayStr}_${telegramId}_${habit.id}`;
      if (sentStreaks.has(notifKey)) continue;
      sentStreaks.add(notifKey);
      bot.telegram.sendMessage(telegramId,
        `⏰ *1 minute reminder!*\n\n📌 *${habit.name}* starts at ${habit.time}\n\nGet ready, ${name}! 💪`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [
          [{ text: `⬜ ${habit.name} — Mark done`, callback_data: `tog_${userId}_${habit.id}` }],
          [{ text: "🚀 Open App", web_app: { url: webAppUrl } }]
        ]}}
      ).catch(() => {});
    }

    // 20:00 — streak milestone
    if (hour === 20 && minute === 0) {
      for (const habit of userHabits) {
        const streak = getStreak(habit);
        if (![3,7,14,21,30,60,100].includes(streak)) continue;
        const key = `streak_${todayStr}_${telegramId}_${habit.id}`;
        if (sentStreaks.has(key)) continue;
        sentStreaks.add(key);
        bot.telegram.sendMessage(telegramId,
          `🔥 *${streak}-Day Streak!*\n\nYou've done "*${habit.name}*" for ${streak} days in a row, ${name}!\n\n${streak>=30?"🏆 Incredible!":streak>=14?"⭐ Real habit!":"💪 Keep going!"}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }
    }
  }
}, 60000);

// ── Launch ────────────────────────────────────────────────────
bot.launch({ allowedUpdates: [], dropPendingUpdates: true });
console.log("🤖 Bot is running!");

const PORT   = process.env.PORT || 10000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Web app running on port ${PORT}`);
  console.log(`🔗 URL: ${DOMAIN}`);
});
server.keepAliveTimeout = 120000;
server.headersTimeout   = 120000;
