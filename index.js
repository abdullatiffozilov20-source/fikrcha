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

// KEY FIX: get user from Google session OR Telegram session
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
  }),
);
app.use(passport.initialize());
app.use(passport.session());

// Middleware: attach user to req for every request
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

// TELEGRAM AUTH
app.post('/auth/telegram', (req, res) => {
  const { user } = req.body;
  if (!user || !user.id) return res.json({ success: false });

  const telegramId = String(user.id);

  // If Google user is logged in, link their telegram
  if (req.user && req.user.id) {
    telegramUsers[telegramId] = req.user.id;
    users[req.user.id].telegramId = telegramId;
    req.session.telegramUserId = req.user.id;
    saveData();
    return res.json({ success: true });
  }

  // Check if telegram already linked to a Google account
  let userId = telegramUsers[telegramId];

  if (!userId) {
    // Create new telegram-only user
    userId = `tg_${telegramId}`;
    users[userId] = {
      id: userId,
      name: user.first_name + (user.last_name ? ' ' + user.last_name : ''),
      email: '',
      avatar: user.photo_url || '',
      isAdmin: false,
      telegramId,
    };
    habits[userId] = [];
    studies[userId] = [];
    diaries[userId] = [];
    telegramUsers[telegramId] = userId;
    saveData();
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
    // Link pending telegram ID if exists
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
  });
});

app.post("/api/link-telegram", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { telegramId } = req.body;
  if (telegramId) {
    telegramUsers[String(telegramId)] = user.id;
    users[user.id].telegramId = String(telegramId);
    saveData();
  }
  res.json({ success: true });
});

// HABITS
app.get("/api/habits", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json(habits[user.id] || []);
});

app.post("/api/habits", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { name, time, category } = req.body;
  const newHabit = { id: Date.now(), name, time: time || "", category: category || "", history: {} };
  if (!habits[user.id]) habits[user.id] = [];
  habits[user.id].push(newHabit);
  saveData();
  res.json({ success: true });
});

app.put("/api/habits/:id", (req, res) => {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  const { name, time, category, history } = req.body;
  const habit = (habits[user.id] || []).find((h) => h.id == req.params.id);
  if (habit) {
    if (name !== undefined) habit.name = name;
    if (time !== undefined) habit.time = time;
    if (category !== undefined) habit.category = category;
    if (history !== undefined) habit.history = history;
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
  const { date, entry, image } = req.body;
  const newDiary = {
    id: Date.now(),
    date,
    entry,
    image: image || null,
    time: new Date().toLocaleTimeString(),
  };
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
    id: u.id,
    name: u.name,
    email: u.email,
    habits: habits[u.id] || [],
    studies: studies[u.id] || [],
    diaries: diaries[u.id] || [],
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

// TELEGRAM BOT
const bot = new Telegraf(process.env.BOT_TOKEN);
const webAppUrl = DOMAIN;

function getTodayStr() {
  return new Date().toISOString().split("T")[0];
}

function buildHabitKeyboard(userId) {
  const today = getTodayStr();
  const userHabits = habits[userId] || [];
  const keyboard = userHabits.map((h) => [
    {
      text: `${h.history[today] ? "✅" : "⬜"} ${h.name}${h.time ? " (" + h.time + ")" : ""}`,
      callback_data: `tog_${userId}_${h.id}`,
    },
  ]);
  keyboard.push([{ text: "📊 Today's Progress", callback_data: `prog_${userId}` }]);
  keyboard.push([{ text: "🚀 Open App", web_app: { url: webAppUrl } }]);
  return keyboard;
}

bot.start((ctx) => {
  ctx.reply(
    "✨ Welcome to FIKRCHA!\n\nOpen the app to set up your habits, then use these commands:\n\n📅 /habits — See & check today's habits\n📔 /diary <text> — Save a diary entry\n📊 /progress — See your weekly stats",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚀 Open FIKRCHA App", web_app: { url: webAppUrl } }],
        ],
      },
    },
  );
});

bot.command("habits", (ctx) => {
  const telegramId = String(ctx.from.id);
  const userId = telegramUsers[telegramId];

  if (!userId) {
    return ctx.reply(
      "👋 First, open the app to link your account. After signing in, come back and try again!",
      {
        reply_markup: {
          inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]],
        },
      },
    );
  }

  const userHabits = habits[userId] || [];
  if (userHabits.length === 0) {
    return ctx.reply("You have no habits yet. Open the app to add some!", {
      reply_markup: {
        inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]],
      },
    });
  }

  const today = getTodayStr();
  const done = userHabits.filter((h) => h.history[today]).length;

  ctx.reply(
    `📅 Your habits for today (${today})\n✅ ${done}/${userHabits.length} completed\n\nTap a habit to check/uncheck it:`,
    { reply_markup: { inline_keyboard: buildHabitKeyboard(userId) } },
  );
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith("tog_")) {
    const parts = data.split("_");
    const habitId = parseInt(parts[parts.length - 1]);
    const userId = parts.slice(1, parts.length - 1).join("_");
    const today = getTodayStr();

    const userHabits = habits[userId] || [];
    const habit = userHabits.find((h) => h.id === habitId);
    if (!habit) return ctx.answerCbQuery("Habit not found");

    habit.history[today] = !habit.history[today];
    const status = habit.history[today] ? "✅ Checked" : "⬜ Unchecked";
    const done = userHabits.filter((h) => h.history[today]).length;

    await ctx.editMessageText(
      `📅 Your habits for today (${today})\n✅ ${done}/${userHabits.length} completed\n\nTap a habit to check/uncheck it:`,
      { reply_markup: { inline_keyboard: buildHabitKeyboard(userId) } },
    );
    await ctx.answerCbQuery(`${status}: ${habit.name}`);
  }

 if (data.startsWith("prog_")) {
    const userId = data.slice(5);
    // Check if this telegram user has a linked Google account
    const tgKey = Object.keys(telegramUsers).find(k => telegramUsers[k] === userId);
    if (tgKey && telegramUsers[tgKey] !== userId) userId = telegramUsers[tgKey];
    // Also check reverse - if userId is a tg_ id, find the real linked account
    const linkedId = Object.values(telegramUsers).find(id => id === userId);
    if (!linkedId) {
      // Try finding by telegram ID directly
      const directLink = telegramUsers[userId.replace('tg_', '')];
      if (directLink) userId = directLink;
    }
    const userHabits = habits[userId] || [];
    const today = getTodayStr();
    const done = userHabits.filter((h) => h.history[today]).length;
    const total = userHabits.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const emoji = pct >= 80 ? "🔥" : pct >= 50 ? "💪" : "⚡";
    
    let weekStats = "";
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const dayDone = userHabits.filter((h) => h.history[dateStr]).length;
      const dayPct = total > 0 ? Math.round((dayDone / total) * 100) : 0;
      const bar = dayPct >= 80 ? "🟢" : dayPct >= 50 ? "🟡" : "🔴";
      const label = i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" });
      weekStats += `${bar} ${label}: ${dayDone}/${total} (${dayPct}%)\n`;
    }

    await ctx.answerCbQuery(`${emoji} Today: ${done}/${total} (${pct}%) — Keep going!`, { show_alert: true });
    await ctx.reply(`📊 Progress for today & this week:\n\n${weekStats}`);
  }
});

bot.command("diary", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const userId = telegramUsers[telegramId];

  if (!userId) {
    return ctx.reply("👋 Open the app first to link your account!", {
      reply_markup: {
        inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]],
      },
    });
  }

  const text = ctx.message.text.replace(/^\/diary\s*/, "").trim();
  if (!text) {
    return ctx.reply(
      "📔 Write your diary entry after the command.\n\nExample:\n/diary Today was a great day!",
    );
  }

  const today = getTodayStr();
  if (!diaries[userId]) diaries[userId] = [];
  diaries[userId].push({
    id: Date.now(),
    date: today,
    entry: text,
    image: null,
    time: new Date().toLocaleTimeString(),
  });
  saveData();
  await ctx.reply(`📔 Diary entry saved for ${today}! ✨`);
});

const done = userHabits.filter((h) => h.history[dateStr]).length;
  const telegramId = String(ctx.from.id);
  const userId = telegramUsers[telegramId];

  if (!userId) {
    return ctx.reply("👋 Open the app first to link your account!", {
      reply_markup: {
        inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: webAppUrl } }]],
      },
    });
  }

  const userHabits = habits[userId] || [];
  if (userHabits.length === 0) {
    return ctx.reply("No habits found. Add some in the app first!");
  }

  let weekStats = "";
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    const done = userHabits.filter((h) => h.history[dateStr]).length;
    const pct = Math.round((done / userHabits.length) * 100);
    const bar = pct >= 80 ? "🟢" : pct >= 50 ? "🟡" : "🔴";
    const label = i === 0 ? "Today" : d.toLocaleDateString("en-US", { weekday: "short" });
    weekStats += `${bar} ${label}: ${done}/${userHabits.length} (${pct}%)\n`;
  }

  const today = getTodayStr();
  const todayDone = userHabits.filter((h) => h.history[today]).length;

  await ctx.reply(
    `📊 Your Weekly Progress\n\n${weekStats}\n💪 Today: ${todayDone}/${userHabits.length} completed`,
  );
});

setInterval(() => {
  const now = new Date();
  if (now.getHours() === 8 && now.getMinutes() === 0) {
    Object.entries(telegramUsers).forEach(([telegramId, userId]) => {
      const userHabits = habits[userId] || [];
      if (userHabits.length === 0) return;
      const name = users[userId]?.name?.split(" ")[0] || "there";
      bot.telegram
        .sendMessage(
          telegramId,
          `🌅 Good morning, ${name}! Time to check your habits for today:`,
          { reply_markup: { inline_keyboard: buildHabitKeyboard(userId) } },
        )
        .catch(() => {});
    });
  }
}, 60000);

bot.launch();
console.log("🤖 Bot is running!");

app.listen(process.env.PORT || 5000, () => console.log("🌐 Web app running on port 5000"));
