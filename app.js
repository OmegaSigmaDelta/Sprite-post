import { CONFIG } from "./config.js";

/* =====================================================================
   Sprite Post. Весь код страницы в одном файле, без сборки.
   Разделы: помощники, вход, запуск, данные, чат, файлы, релизы, аккаунт.
   ===================================================================== */

/* ---------- помощники ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
}

class UserError extends Error {}

const ROLE = { developer: "Разработчик", artist: "Художник" };
const BUCKET = "sprites";
const MB = 1048576;
const LIMIT = CONFIG.STORAGE_LIMIT_MB * MB;
const MAX_FILE = CONFIG.MAX_FILE_MB * MB;
const THUMB_MAX = CONFIG.THUMB_MAX_MB * MB;
const URL_TTL = 7 * 24 * 3600;
const ALLOWED_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "json", "txt", "md", "csv", "pdf", "zip", "aseprite", "ase", "psd"]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  json: "application/json", txt: "text/plain", md: "text/markdown", csv: "text/csv", pdf: "application/pdf", zip: "application/zip" };
const REMEMBER_KEY = "sp_remember";
const URLS_KEY = "sp_urls";

const S = {
  uid: null, email: "", me: null, entered: null,
  profiles: new Map(), messages: [], hasOlder: false, files: [], releases: [], settings: {},
  panel: "chat", query: "", reply: null, pending: [], unread: 0, forceBottom: true,
  syncing: false, syncError: "", urls: {}
};
let sb = null;
let channel = null;
let subscribedOnce = false;
let pendingTimer = 0;
let toastTimer = 0;

const extOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(name || ""); return m ? m[1].toLowerCase() : ""; };
const fmtSize = (n) => (n < 1024 ? `${n} Б` : n < MB ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} КБ` : `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} МБ`);
const snippet = (s) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > 80 ? s.slice(0, 80) + "…" : s; };
const isDev = () => S.me?.role === "developer";
const authorName = (id) => (id ? S.profiles.get(id)?.name || "Участник" : "Удалённый участник");
const usedBytes = () => S.files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const hm = d.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.toLocaleDateString("ru", { day: "numeric", month: "short" })}, ${hm}`;
}
function fmtDay(iso) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Сегодня";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Вчера";
  return d.toLocaleDateString("ru", { day: "numeric", month: "long" });
}
const match = (...parts) => !S.query || S.query.split(/\s+/).every((w) => parts.some((p) => String(p || "").toLowerCase().includes(w)));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}
function errText(e) {
  if (e instanceof UserError) return e.message;
  const m = String(e?.message || e || "");
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Нет связи с сервером. Проверьте интернет.";
  if (/storage_quota/.test(m)) return "Хранилище заполнено. Удалите ненужные файлы.";
  if (/row-level security|permission denied|forbidden/i.test(m)) return "Нет прав на это действие.";
  if (/exceeded the maximum allowed size|too large/i.test(m)) return `Файл больше ${CONFIG.MAX_FILE_MB} МБ.`;
  return m || "Что-то пошло не так.";
}
function authError(error) {
  const m = String(error?.message || "");
  if (/Invalid login credentials/i.test(m)) return "Неверная почта или пароль.";
  if (/Email not confirmed/i.test(m)) return "Почта не подтверждена. Отключите подтверждение почты в Supabase (руководство, шаг 3).";
  if (/already registered|already been registered/i.test(m)) return "Эта почта уже зарегистрирована. Откройте вкладку «Вход».";
  if (/Database error saving new user|invalid_invite/i.test(m)) return "Не удалось создать аккаунт. Проверьте кодовое слово.";
  if (/at least \d+ characters|weak/i.test(m)) return "Пароль слишком простой или короткий.";
  if (/rate limit|too many|429/i.test(m)) return "Слишком много попыток. Подождите несколько минут.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Нет связи с сервером. Проверьте интернет или доступность Supabase.";
  if (/different from the old password|same_password/i.test(m)) return "Новый пароль должен отличаться от старого.";
  return m || "Не удалось выполнить действие.";
}

function armButton(label, confirmLabel, action, cls = "link") {
  let armed = false, timer = 0;
  const b = h("button", { class: cls, type: "button" }, label);
  b.addEventListener("click", () => {
    if (!armed) {
      armed = true; b.textContent = confirmLabel;
      timer = setTimeout(() => { armed = false; b.textContent = label; }, 4000);
      return;
    }
    clearTimeout(timer); armed = false; b.textContent = label; action();
  });
  return b;
}
function flashNode(node) {
  if (!node) { toast("Не найдено среди текущих результатов"); return; }
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.remove("flash"); void node.offsetWidth; node.classList.add("flash");
}

/* ---------- безопасный показ описания релиза (минимальный Markdown) ---------- */
function mdLink(href, label) { return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, label); }
function mdInline(text) {
  const frag = document.createDocumentFragment();
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<)]+)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] != null) frag.append(h("code", null, m[1]));
    else if (m[2] != null) frag.append(h("strong", null, m[2]));
    else if (m[4]) frag.append(mdLink(m[4], m[3]));
    else frag.append(mdLink(m[5], m[5]));
    last = re.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}
function mdToNodes(src) {
  const out = document.createDocumentFragment();
  let text = String(src || "").replace(/\r/g, "");
  if (text.length > 8000) text = text.slice(0, 8000) + "\n…";
  let para = [], list = null, code = null;
  const flushPara = () => { if (para.length) { out.append(h("p", null, mdInline(para.join(" ")))); para = []; } };
  const flushList = () => { if (list) { out.append(list); list = null; } };
  for (const line of text.split("\n")) {
    if (code) { if (/^```/.test(line)) { out.append(h("pre", null, code.join("\n"))); code = null; } else code.push(line); continue; }
    if (/^```/.test(line)) { flushPara(); flushList(); code = []; continue; }
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) { flushPara(); flushList(); out.append(h("h3", null, mdInline(hd[2]))); continue; }
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li) { flushPara(); if (!list) list = h("ul"); list.append(h("li", null, mdInline(li[1]))); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList(); para.push(line.trim());
  }
  if (code) out.append(h("pre", null, code.join("\n")));
  flushPara(); flushList();
  return out;
}

/* ---------- хранение входа: вкладка или устройство ---------- */
const authStorage = {
  getItem(k) { try { return sessionStorage.getItem(k) ?? localStorage.getItem(k); } catch { return null; } },
  setItem(k, v) {
    try {
      const remember = localStorage.getItem(REMEMBER_KEY) === "1";
      (remember ? localStorage : sessionStorage).setItem(k, v);
      (remember ? sessionStorage : localStorage).removeItem(k);
    } catch { /* хранилище недоступно */ }
  },
  removeItem(k) { try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch { /* ничего */ } }
};

/* ---------- экраны ---------- */
function showScreen(name) {
  for (const id of ["boot", "setup", "auth", "pending"]) $("#" + id).hidden = id !== name;
}
function fatal(text) {
  showScreen("setup");
  $("#setup-text").textContent = text;
}

/* ---------- запуск ---------- */
const configured = /^https:\/\//.test(CONFIG.SUPABASE_URL || "") && CONFIG.SUPABASE_KEY && !/ВАШ|YOUR/i.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_KEY);

async function boot() {
  bindUI();
  if (!configured) { showScreen("setup"); return; }
  if (!window.supabase?.createClient) { fatal("Не загрузилась библиотека Supabase. Обновите страницу."); return; }
  sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
    auth: { storage: authStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  try { S.urls = JSON.parse(localStorage.getItem(URLS_KEY) || "{}"); } catch { S.urls = {}; }

  sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") { setTimeout(() => location.reload(), 0); return; }
    if (event === "SIGNED_IN" && session) setTimeout(() => enter(session), 0);
  });

  let session = null;
  try { session = (await sb.auth.getSession()).data.session; }
  catch { fatal("Нет связи с Supabase. Проверьте интернет и адрес в config.js."); return; }
  if (session) await enter(session); else showScreen("auth");
}

async function enter(session) {
  if (S.entered === session.user.id) return;
  S.entered = session.user.id;
  S.uid = session.user.id;
  S.email = session.user.email || "";
  showScreen("boot");
  let res;
  try { res = await sb.from("profiles").select("*").eq("id", S.uid).maybeSingle(); }
  catch (e) { S.entered = null; fatal(errText(e)); return; }
  if (res.error || !res.data) {
    S.entered = null;
    fatal("Профиль не найден. Скорее всего, не выполнен SQL из шага 3 руководства. Выйдите и зарегистрируйтесь снова.");
    return;
  }
  S.me = res.data;
  if (!S.me.approved) { showPending(); return; }
  await startApp();
}

function showPending() {
  showScreen("pending");
  clearInterval(pendingTimer);
  pendingTimer = setInterval(checkApproval, 10000);
}
async function checkApproval() {
  const { data } = await sb.from("profiles").select("*").eq("id", S.uid).maybeSingle();
  if (data?.approved) { clearInterval(pendingTimer); S.me = data; await startApp(); }
}
async function logout() {
  try { localStorage.removeItem(URLS_KEY); } catch { /* ничего */ }
  try { await sb.auth.signOut(); } catch { /* ничего */ }
  location.reload();
}

function playWelcome(gate) {
  return new Promise((resolve) => {
    const w = $("#welcome");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    w.hidden = false; w.classList.remove("leaving", "play"); void w.offsetWidth; w.classList.add("play");
    let started = false;
    const leave = () => {
      if (started) return;
      started = true;
      w.classList.add("leaving");
      resolve();
      setTimeout(() => { w.hidden = true; w.classList.remove("play", "leaving"); }, reduce ? 0 : 650);
    };
    const finish = () => Promise.resolve(gate).then(leave, leave);
    $("p", w).addEventListener("animationend", finish, { once: true });
    w.addEventListener("click", finish, { once: true });
    setTimeout(finish, reduce ? 1400 : 3200);
  });
}

async function startApp() {
  showScreen("none");
  $("#who-name").textContent = S.me.name;
  $("#who-role").textContent = ROLE[S.me.role];
  $("#welcome-role").textContent = ROLE[S.me.role];
  $("#dev-tools").hidden = !isDev();
  $("#dev-more").hidden = !isDev();
  $("#app").hidden = false;
  $("#app").classList.remove("ready");

  const loading = loadAll();
  const welcome = playWelcome(loading);
  await Promise.all([loading, welcome]);
  subscribe();
  setPanel("chat");
  $("#app").classList.add("ready");
  setupNotifBanner();
  if (isDev()) syncReleases(false);
  setInterval(() => { if (isDev() && !document.hidden) syncReleases(false); }, CONFIG.RELEASE_SYNC_MINUTES * 60000);
}

/* ---------- загрузка данных и живые обновления ---------- */
async function loadAll(silent) {
  try {
    const [pr, ms, fs, rs, ss] = await Promise.all([
      sb.from("profiles").select("id,name,role,requested_role,approved,created_at"),
      sb.from("messages").select("*").order("created_at", { ascending: false }).limit(CONFIG.MESSAGES_PAGE),
      sb.from("files").select("*").order("created_at", { ascending: false }).limit(500),
      sb.from("releases").select("*").order("published_at", { ascending: false, nullsFirst: false }).limit(60),
      sb.from("settings").select("key,value")
    ]);
    for (const r of [pr, ms, fs, rs, ss]) if (r.error) throw r.error;
    S.profiles = new Map(pr.data.map((p) => [p.id, p]));
    S.messages = ms.data.slice().reverse();
    S.hasOlder = ms.data.length >= CONFIG.MESSAGES_PAGE;
    S.files = fs.data;
    S.releases = rs.data;
    S.settings = Object.fromEntries(ss.data.map((r) => [r.key, r.value]));
  } catch (e) {
    if (!silent) toast(errText(e));
  }
  renderAll();
}

async function loadOlder() {
  const first = S.messages[0];
  if (!first) return;
  const { data, error } = await sb.from("messages").select("*").lt("created_at", first.created_at)
    .order("created_at", { ascending: false }).limit(CONFIG.MESSAGES_PAGE);
  if (error) { toast(errText(error)); return; }
  S.messages = data.slice().reverse().concat(S.messages);
  S.hasOlder = data.length >= CONFIG.MESSAGES_PAGE;
  renderChat();
}

function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel("sp-main");
  for (const table of ["messages", "files", "releases", "profiles", "settings"]) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, (p) => onChange(table, p));
  }
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      if (subscribedOnce) loadAll(true);
      subscribedOnce = true;
    }
  });
}

const upsertBy = (arr, key, row) => { const i = arr.findIndex((x) => x[key] === row[key]); if (i >= 0) arr[i] = row; else arr.push(row); };
const sortReleases = () => S.releases.sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));

function onChange(table, p) {
  const type = p.eventType, row = p.new, old = p.old;
  if (table === "messages") {
    if (type === "INSERT") addMessage(row, true);
    else if (type === "DELETE") { S.messages = S.messages.filter((m) => m.id !== old.id); renderChat(); }
  } else if (table === "files") {
    if (type === "INSERT") addFile(row, true);
    else if (type === "DELETE") { S.files = S.files.filter((f) => f.id !== old.id); renderFiles(); renderChat(); }
  } else if (table === "releases") {
    if (type === "DELETE") S.releases = S.releases.filter((r) => r.gh_id !== old.gh_id);
    else {
      const prev = S.releases.find((r) => r.gh_id === row.gh_id);
      upsertBy(S.releases, "gh_id", row);
      if (!isDev() && (!prev || (!prev.shared && row.shared))) incoming("releases", `Новый релиз ${row.tag}`, row.name || "Можно скачать");
    }
    sortReleases(); renderReleases();
  } else if (table === "profiles") {
    if (type === "DELETE") { S.profiles.delete(old.id); if (old.id === S.uid) logout(); }
    else {
      S.profiles.set(row.id, row);
      if (row.id === S.uid) {
        S.me = { ...S.me, ...row };
        if (!row.approved) { location.reload(); return; }
      } else if (type === "INSERT" && isDev() && !row.approved) {
        incoming("more", "Новая заявка", `${row.name} хочет войти как ${ROLE[row.requested_role]}`);
      }
    }
    renderMore(); renderChat();
  } else if (table === "settings") {
    if (type === "DELETE") delete S.settings[old.key]; else S.settings[row.key] = row.value;
    renderReleases(); renderMore();
  }
}

/* ---------- уведомления ---------- */
const notifSupported = () => "Notification" in window;
async function pushNotify(title, body, tag) {
  if (!notifSupported() || Notification.permission !== "granted") return;
  const opts = { body, tag, icon: "icons/icon-192.png", badge: "icons/icon-192.png", renotify: true };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) { await reg.showNotification(title, opts); return; }
  } catch { /* пробуем обычный способ */ }
  try { const n = new Notification(title, opts); n.onclick = () => { window.focus(); n.close(); }; } catch { /* ничего */ }
}
function updateTitle() { document.title = S.unread ? `(${S.unread}) Sprite Post` : "Sprite Post"; }
function markBadge(panel, on) { const d = $("#badge-" + panel); if (d) d.hidden = !on; }

function incoming(panel, title, body) {
  const viewing = !document.hidden && S.panel === panel;
  if (viewing) return;
  markBadge(panel, true);
  if (document.hidden) { S.unread++; updateTitle(); pushNotify(title, body, panel); }
  else toast(`${title}: ${body}`);
}

function renderNotifState() {
  const state = $("#notif-state"), btn = $("#notif-toggle");
  if (!notifSupported()) {
    state.textContent = "Этот браузер не поддерживает уведомления. На iPhone установите сайт на экран «Домой» (Safari: Поделиться, затем «На экран Домой») и откройте его оттуда.";
    btn.hidden = true; return;
  }
  const p = Notification.permission;
  btn.hidden = p !== "default";
  state.textContent = p === "granted"
    ? "Уведомления включены. Они приходят, пока сайт открыт во вкладке или в приложении. Если закрыть вкладку, уведомления прекратятся."
    : p === "denied"
      ? "Уведомления запрещены в настройках браузера. Разрешите их для этого сайта, чтобы включить."
      : "Уведомления выключены. Включите, чтобы получать сообщения, пока сайт открыт во вкладке.";
}
async function enableNotifications() {
  try { await Notification.requestPermission(); } catch { /* ничего */ }
  renderNotifState(); setupNotifBanner();
}
function setupNotifBanner() {
  let dismissed = false;
  try { dismissed = localStorage.getItem("sp_notif_dismissed") === "1"; } catch { /* ничего */ }
  $("#notif-banner").hidden = !(notifSupported() && Notification.permission === "default" && !dismissed);
}

/* ---------- навигация и перерисовка ---------- */
function setPanel(name) {
  S.panel = name;
  for (const sec of $$(".panel")) sec.hidden = sec.dataset.panel !== name;
  for (const b of $$(".nav button")) {
    if (b.dataset.panel === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  markBadge(name, false);
  if (name === "chat") { S.forceBottom = true; S.unread = 0; updateTitle(); renderChat(); }
  else if (name === "files") renderFiles();
  else if (name === "releases") renderReleases();
  else renderMore();
}
function renderAll() { renderChat(); renderFiles(); renderReleases(); renderMore(); }
const inactive = (name) => S.panel !== name;

/* ---------- чат ---------- */
function addMessage(row, live) {
  if (S.messages.some((m) => m.id === row.id)) return;
  S.messages.push(row);
  S.messages.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (live && row.author !== S.uid) {
    incoming("chat", authorName(row.author), row.body ? snippet(row.body) : "Прислал(а) файл");
  }
  renderChat();
}

function quoteNode(m) {
  if (!m.reply_to && !m.reply_file) return null;
  let label, go;
  if (m.reply_file) {
    const f = S.files.find((x) => x.id === m.reply_file);
    label = f ? `Файл: ${f.name}` : "Файл удалён";
    go = () => f && jumpToFile(f.id);
  } else {
    const o = S.messages.find((x) => x.id === m.reply_to);
    label = o ? `${authorName(o.author)}: ${snippet(o.body || "вложение")}` : "Сообщение удалено или ещё не загружено";
    go = () => o && flashNode($(`[data-mid="${o.id}"]`));
  }
  return h("button", { class: "quote", type: "button", onclick: go }, label);
}

function attNode(id) {
  const f = S.files.find((x) => x.id === id);
  if (!f) return h("div", { class: "att" }, h("span", { class: "an" }, "Файл удалён"));
  const ext = extOf(f.name);
  const tn = h("div", { class: "tn" });
  if (IMG_EXT.has(ext) && f.size <= THUMB_MAX) loadThumb(f, tn); else tn.textContent = ext || "файл";
  return h("div", { class: "att" }, tn,
    h("button", { class: "an", type: "button", onclick: () => jumpToFile(f.id) }, `${f.name} · ${fmtSize(f.size)}`),
    h("button", { class: "btn small", type: "button", onclick: () => downloadFile(f) }, "Скачать"));
}

function messageNode(m) {
  const mine = m.author === S.uid;
  const bubble = h("div", { class: "bubble" });
  const q = quoteNode(m);
  if (q) bubble.append(q);
  if (m.body) bubble.append(h("div", { class: "text" }, m.body));
  if (m.file_ids?.length) bubble.append(h("div", { class: "atts" }, m.file_ids.map(attNode)));
  const act = h("div", { class: "mact" },
    h("button", { class: "link", type: "button", onclick: () => startReply({ kind: "msg", id: m.id }) }, "Ответить"));
  if (mine || isDev()) act.append(armButton("Удалить", "Точно удалить?", () => deleteMessage(m)));
  return h("div", { class: "msg" + (mine ? " mine" : ""), "data-mid": m.id },
    h("div", { class: "who-line" }, `${authorName(m.author)} · ${fmtTime(m.created_at)}`), bubble, act);
}

function renderChat() {
  if (inactive("chat")) return;
  const feed = $("#feed");
  const nearBottom = S.forceBottom || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
  const list = S.messages.filter((m) => {
    const names = (m.file_ids || []).map((id) => S.files.find((f) => f.id === id)?.name);
    return match(m.body, authorName(m.author), ...names);
  });
  feed.replaceChildren();
  if (S.hasOlder && !S.query) feed.append(h("button", { class: "btn ghost small older", type: "button", onclick: loadOlder }, "Показать более ранние"));
  if (!list.length) {
    feed.append(h("div", { class: "empty" }, S.query ? `По запросу «${S.query}» сообщений не найдено.` : "Сообщений пока нет. Напишите первое."));
  }
  let day = "";
  for (const m of list) {
    const d = new Date(m.created_at).toDateString();
    if (d !== day) { day = d; feed.append(h("div", { class: "day" }, fmtDay(m.created_at))); }
    feed.append(messageNode(m));
  }
  if (nearBottom && !S.query) feed.scrollTop = feed.scrollHeight;
  S.forceBottom = false;
}

async function deleteMessage(m) {
  const { error } = await sb.from("messages").delete().eq("id", m.id);
  if (error) { toast(errText(error)); return; }
  S.messages = S.messages.filter((x) => x.id !== m.id);
  renderChat();
}

function startReply(r) {
  S.reply = r;
  renderReply();
  setPanel("chat");
  $("#msg-input").focus();
}
function renderReply() {
  const bar = $("#replybar");
  if (!S.reply) { bar.hidden = true; return; }
  let text;
  if (S.reply.kind === "file") {
    const f = S.files.find((x) => x.id === S.reply.id);
    text = `Ответ на файл: ${f ? f.name : "удалён"}`;
  } else {
    const m = S.messages.find((x) => x.id === S.reply.id);
    text = `Ответ на сообщение: ${m ? snippet(m.body || "вложение") : "удалено"}`;
  }
  $("#reply-text").textContent = text;
  bar.hidden = false;
}
function renderChips() {
  const box = $("#chips");
  box.replaceChildren();
  box.hidden = !S.pending.length;
  S.pending.forEach((f, i) => {
    box.append(h("span", { class: "chip" }, `${f.name} · ${fmtSize(f.size)}`,
      h("button", { type: "button", "aria-label": `Убрать ${f.name}`, onclick: () => { S.pending.splice(i, 1); renderChips(); } }, "×")));
  });
}

function checkFile(file) {
  const ext = extOf(file.name);
  if (!ALLOWED_EXT.has(ext)) throw new UserError(`${file.name}: такой формат не поддерживается`);
  if (file.size === 0) throw new UserError(`${file.name}: файл пустой`);
  if (file.size > MAX_FILE) throw new UserError(`${file.name}: файл больше ${CONFIG.MAX_FILE_MB} МБ`);
}

async function sendMessage(e) {
  e.preventDefault();
  const input = $("#msg-input");
  const body = input.value.trim();
  if (!body && !S.pending.length) return;
  const btn = $("#send-btn");
  btn.disabled = true;
  try {
    const fileIds = [];
    for (let i = 0; i < S.pending.length; i++) {
      btn.textContent = `Загрузка ${i + 1}/${S.pending.length}`;
      fileIds.push((await uploadFile(S.pending[i], { viaMessage: true })).id);
    }
    const row = {};
    if (body) row.body = body;
    if (fileIds.length) row.file_ids = fileIds;
    if (S.reply) { if (S.reply.kind === "file") row.reply_file = S.reply.id; else row.reply_to = S.reply.id; }
    const { data, error } = await sb.from("messages").insert(row).select().single();
    if (error) throw error;
    input.value = ""; input.style.height = "auto";
    S.pending = []; S.reply = null; S.forceBottom = true;
    renderChips(); renderReply();
    addMessage(data, false);
  } catch (err) {
    toast(errText(err));
  }
  btn.textContent = "Отправить";
  btn.disabled = false;
}

/* ---------- файлы ---------- */
function saveUrls() {
  const now = Date.now();
  for (const k of Object.keys(S.urls)) if (S.urls[k].e < now) delete S.urls[k];
  try { localStorage.setItem(URLS_KEY, JSON.stringify(S.urls)); } catch { /* ничего */ }
}
const urlQueue = new Map();
let urlTimer = 0;
function getUrl(path) {
  const c = S.urls[path];
  if (c && c.e - Date.now() > 86400000) return Promise.resolve(c.u);
  return new Promise((resolve, reject) => {
    const entry = urlQueue.get(path) || { waiters: [] };
    entry.waiters.push({ resolve, reject });
    urlQueue.set(path, entry);
    if (!urlTimer) urlTimer = setTimeout(flushUrls, 30);
  });
}
async function flushUrls() {
  urlTimer = 0;
  const batch = Array.from(urlQueue.entries());
  urlQueue.clear();
  try {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(batch.map(([p]) => p), URL_TTL);
    if (error) throw error;
    const byPath = new Map(data.map((d) => [d.path, d]));
    for (const [p, entry] of batch) {
      const d = byPath.get(p);
      if (d?.signedUrl) { S.urls[p] = { u: d.signedUrl, e: Date.now() + URL_TTL * 1000 }; entry.waiters.forEach((w) => w.resolve(d.signedUrl)); }
      else entry.waiters.forEach((w) => w.reject(new Error("no url")));
    }
    saveUrls();
  } catch (e) {
    for (const [, entry] of batch) entry.waiters.forEach((w) => w.reject(e));
  }
}

function loadThumb(f, box, onSize) {
  getUrl(f.path).then((url) => {
    const img = h("img", { src: url, alt: f.name, decoding: "async", loading: "lazy" });
    img.onload = () => {
      if (img.naturalWidth && img.naturalWidth <= 160) img.classList.add("px");
      if (onSize && img.naturalWidth) onSize(img.naturalWidth, img.naturalHeight);
    };
    img.onerror = () => box.replaceChildren(h("div", { class: "gone" }, "Файл недоступен"));
    box.replaceChildren(img);
  }).catch(() => box.replaceChildren(h("div", { class: "gone" }, "Не удалось загрузить")));
}

async function downloadFile(f) {
  try {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(f.path, 120, { download: f.name });
    if (error) throw error;
    const a = h("a", { href: data.signedUrl, rel: "noopener" });
    document.body.append(a); a.click(); a.remove();
  } catch (e) { toast(errText(e)); }
}

function addFile(row, live) {
  if (S.files.some((f) => f.id === row.id)) return;
  S.files.unshift(row);
  if (live && row.uploader !== S.uid && !row.via_message) incoming("files", "Новый файл", `${authorName(row.uploader)}: ${row.name}`);
  renderFiles(); renderChat();
}

async function uploadFile(file, { note = "", viaMessage = false } = {}) {
  checkFile(file);
  if (usedBytes() + file.size > LIMIT) throw new UserError("Хранилище почти заполнено. Удалите ненужные файлы.");
  const ext = extOf(file.name);
  const path = `${S.uid}/${crypto.randomUUID()}.${ext}`;
  const up = await sb.storage.from(BUCKET).upload(path, file, {
    contentType: MIME[ext] || "application/octet-stream", cacheControl: "31536000", upsert: false
  });
  if (up.error) throw up.error;
  const { data, error } = await sb.from("files").insert({
    name: file.name.slice(0, 120), mime: MIME[ext] || "application/octet-stream", size: file.size, path, note: note || null, via_message: viaMessage
  }).select().single();
  if (error) { await sb.storage.from(BUCKET).remove([path]); throw error; }
  addFile(data, false);
  return data;
}

async function uploadMany(list) {
  const files = Array.from(list);
  const note = $("#pick-note").value.trim();
  const status = $("#upload-status");
  let done = 0;
  for (let i = 0; i < files.length; i++) {
    status.textContent = `Загружаю ${files[i].name} (${i + 1} из ${files.length})…`;
    try { await uploadFile(files[i], { note }); done++; }
    catch (e) { toast(errText(e)); }
  }
  status.textContent = done ? (done === 1 ? "Файл загружен." : `Загружено файлов: ${done}.`) : "";
  if (done) $("#pick-note").value = "";
  $("#pick-input").value = "";
}

async function deleteFile(f) {
  const { error } = await sb.from("files").delete().eq("id", f.id);
  if (error) { toast(errText(error)); return; }
  S.files = S.files.filter((x) => x.id !== f.id);
  sb.storage.from(BUCKET).remove([f.path]).catch(() => {});
  renderFiles(); renderChat();
}

function fileCard(f) {
  const ext = extOf(f.name);
  const thumb = h("div", { class: "thumb" });
  const meta = h("div", { class: "fmeta" }, [authorName(f.uploader), fmtTime(f.created_at), fmtSize(f.size)].join(" · "));
  const onSize = (w, hh) => { meta.textContent += ` · ${w}×${hh}`; };
  if (IMG_EXT.has(ext)) {
    if (f.size <= THUMB_MAX) loadThumb(f, thumb, onSize);
    else thumb.append(h("button", { class: "btn small", type: "button", onclick: (e) => { e.currentTarget.disabled = true; loadThumb(f, thumb, onSize); } }, "Показать превью"));
  } else thumb.append(h("div", { class: "ext" }, ext || "файл"));
  const actions = h("div", { class: "factions" },
    h("button", { class: "btn small primary", type: "button", onclick: () => downloadFile(f) }, "Скачать"),
    h("button", { class: "btn small ghost", type: "button", onclick: () => startReply({ kind: "file", id: f.id }) }, "Ответить"));
  if (f.uploader === S.uid || isDev()) actions.append(armButton("Удалить", "Точно удалить?", () => deleteFile(f), "btn small ghost danger"));
  return h("article", { class: "fcard", "data-fid": f.id }, thumb,
    h("div", { class: "fbody" }, h("div", { class: "fname" }, f.name), f.note ? h("div", { class: "fnote" }, f.note) : null, meta, actions));
}

function jumpToFile(id) {
  S.query = ""; $("#q").value = "";
  setPanel("files");
  requestAnimationFrame(() => flashNode($(`[data-fid="${id}"]`)));
}

function renderFiles() {
  if (inactive("files")) return;
  const used = usedBytes();
  $("#meter-fill").style.width = Math.min(100, (used / LIMIT) * 100).toFixed(1) + "%";
  $("#meter-text").textContent = `${fmtSize(used)} из ${CONFIG.STORAGE_LIMIT_MB} МБ`;
  $("#meter").classList.toggle("warn", used / LIMIT > 0.8);
  const list = S.files.filter((f) => match(f.name, f.note, authorName(f.uploader)));
  const empty = $("#files-empty");
  empty.hidden = list.length > 0;
  empty.textContent = S.query && S.files.length ? `По запросу «${S.query}» файлов не найдено.` : "Пока ничего нет. Загруженные файлы, в том числе прикреплённые к сообщениям, появятся здесь.";
  $("#files-grid").replaceChildren(...list.map(fileCard));
}

/* ---------- релизы ---------- */
function relCard(r, isLatest) {
  const dev = isDev();
  const card = h("article", { class: "rel" + (r.prerelease ? " pre" : "") + (isLatest ? " latest" : "") });
  card.append(h("div", { class: "rtop" },
    h("span", { class: "rtag" }, r.tag || "без версии"),
    h("span", { class: "badge" + (isLatest ? " latest" : "") }, r.prerelease ? "Пререлиз" : isLatest ? "Последний релиз" : "Релиз"),
    dev && !r.shared ? h("span", { class: "pill" }, "Скрыт от художника") : null,
    r.name && r.name !== r.tag ? h("span", { class: "rname" }, r.name) : null));
  if (r.published_at) card.append(h("div", { class: "rdate" }, `Опубликован: ${fmtTime(r.published_at)}`));
  if (r.body && r.body.trim()) card.append(h("details", null, h("summary", null, "Описание"), h("div", { class: "rbody" }, mdToNodes(r.body))));
  const assets = (Array.isArray(r.assets) ? r.assets : []).filter((a) => /^https:\/\//.test(a?.url || ""));
  const links = h("div", { class: "assets" });
  for (const a of assets) {
    links.append(h("a", { class: "btn small primary", href: a.url, target: "_blank", rel: "noopener noreferrer" }, `Скачать ${a.name}${a.size ? " · " + fmtSize(a.size) : ""}`));
  }
  if (!assets.length && /^https:\/\//.test(r.html_url || "")) {
    links.append(h("a", { class: "btn small primary", href: r.html_url, target: "_blank", rel: "noopener noreferrer" }, "Открыть на GitHub"));
  }
  card.append(links);
  if (dev) {
    const act = h("div", { class: "ractions" },
      h("button", { class: "btn small ghost", type: "button", onclick: () => toggleShared(r) }, r.shared ? "Скрыть от художника" : "Показать художнику"));
    if (/^https:\/\//.test(r.html_url || "")) act.append(h("a", { class: "btn small ghost", href: r.html_url, target: "_blank", rel: "noopener noreferrer" }, "Страница на GitHub"));
    card.append(act);
  }
  return card;
}

async function toggleShared(r) {
  const { error } = await sb.from("releases").update({ shared: !r.shared }).eq("gh_id", r.gh_id);
  if (error) { toast(errText(error)); return; }
  r.shared = !r.shared;
  renderReleases();
}

function renderReleases() {
  if (inactive("releases")) return;
  const dev = isDev();
  const visible = S.releases.filter((r) => dev || r.shared);
  const latest = visible.find((r) => !r.prerelease);
  const list = visible.filter((r) => match(r.tag, r.name, r.body));
  const repoInput = $("#repo-input");
  if (document.activeElement !== repoInput) repoInput.value = S.settings.repo || CONFIG.DEFAULT_REPO || "";
  const at = S.settings.releases_synced_at;
  $("#sync-status").textContent = S.syncing ? "Проверяю GitHub…"
    : S.syncError ? S.syncError
    : at ? `Сверено с GitHub: ${fmtTime(at)}` : (dev ? "Ещё не сверялось с GitHub" : "");
  const empty = $("#rel-empty");
  empty.hidden = list.length > 0;
  empty.textContent = S.query && visible.length ? `По запросу «${S.query}» релизов не найдено.`
    : dev ? "Релизов пока нет. Укажите репозиторий игры выше и нажмите «Проверить сейчас»."
      : "Разработчик пока не открыл для вас ни одного релиза.";
  $("#rel-list").replaceChildren(...list.map((r) => relCard(r, latest && r.gh_id === latest.gh_id)));
}

async function saveReleases(list) {
  const now = new Date().toISOString();
  const existing = new Set(S.releases.map((r) => Number(r.gh_id)));
  const map = (r) => ({
    gh_id: r.id, tag: r.tag_name || "", name: r.name || "", body: r.body || "", prerelease: !!r.prerelease,
    html_url: r.html_url || "", published_at: r.published_at || r.created_at || null,
    assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url })), synced_at: now
  });
  const old = list.filter((r) => existing.has(r.id)).map(map);
  // Новые пререлизы по умолчанию скрыты от художника, новые обычные релизы видны.
  const fresh = list.filter((r) => !existing.has(r.id)).map((r) => ({ ...map(r), shared: !r.prerelease }));
  for (const rows of [old, fresh]) {
    if (!rows.length) continue;
    const { error } = await sb.from("releases").upsert(rows, { onConflict: "gh_id" });
    if (error) throw error;
  }
  if (list.length < 30) {
    const ids = list.map((r) => r.id);
    const q = sb.from("releases").delete();
    const { error } = ids.length ? await q.not("gh_id", "in", `(${ids.join(",")})`) : await q.gt("gh_id", 0);
    if (error) throw error;
  }
  const { error } = await sb.from("settings").upsert({ key: "releases_synced_at", value: now }, { onConflict: "key" });
  if (error) throw error;
  S.settings.releases_synced_at = now;
  const rs = await sb.from("releases").select("*").order("published_at", { ascending: false, nullsFirst: false }).limit(60);
  if (!rs.error) S.releases = rs.data;
}

async function syncReleases(manual) {
  if (!isDev() || S.syncing) return;
  const repo = (S.settings.repo || CONFIG.DEFAULT_REPO || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { if (manual) toast("Укажите репозиторий в виде автор/игра"); return; }
  S.syncing = true; S.syncError = ""; renderReleases();
  try {
    let res;
    try { res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers: { Accept: "application/vnd.github+json" } }); }
    catch { throw new UserError("GitHub не открывается с этого устройства. Попробуйте позже или включите автосверку (шаг 9 руководства)."); }
    if (res.status === 404) throw new UserError("Репозиторий не найден или закрыт. Проверьте название.");
    if (res.status === 403 || res.status === 429) throw new UserError("GitHub временно ограничил запросы. Повторите через час.");
    if (!res.ok) throw new UserError(`GitHub ответил ошибкой ${res.status}.`);
    const list = (await res.json()).filter((r) => !r.draft);
    await saveReleases(list);
    if (manual) toast(list.length ? `Релизов на GitHub: ${list.length}` : "На GitHub пока нет релизов");
  } catch (e) {
    S.syncError = errText(e);
    if (manual) toast(S.syncError);
  }
  S.syncing = false;
  renderReleases();
}

async function saveRepo() {
  const v = $("#repo-input").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(v)) { toast("Укажите репозиторий в виде автор/игра"); return; }
  const { error } = await sb.from("settings").upsert({ key: "repo", value: v }, { onConflict: "key" });
  if (error) { toast(errText(error)); return; }
  S.settings.repo = v; S.syncError = "";
  toast("Репозиторий сохранён");
  syncReleases(true);
}

/* ---------- аккаунт и участники ---------- */
async function refreshProfiles() {
  const { data, error } = await sb.from("profiles").select("id,name,role,requested_role,approved,created_at");
  if (!error) S.profiles = new Map(data.map((p) => [p.id, p]));
  renderMore(); renderChat();
}
async function setMember(id, approve, role) {
  const { error } = await sb.rpc("set_member", { target: id, do_approve: approve, new_role: role ?? null });
  if (error) { toast(errText(error)); return; }
  await refreshProfiles();
}
async function removeMember(id) {
  const { error } = await sb.rpc("remove_member", { target: id });
  if (error) { toast(errText(error)); return; }
  await refreshProfiles();
}
function memberCard(p) {
  const other = p.requested_role === "developer" ? "artist" : "developer";
  const acts = h("div", { class: "row" });
  let meta;
  if (!p.approved) {
    meta = `Ждёт подтверждения, просит роль: ${ROLE[p.requested_role]}`;
    acts.append(
      h("button", { class: "btn small primary", type: "button", onclick: () => setMember(p.id, true, p.requested_role) }, `Принять: ${ROLE[p.requested_role]}`),
      h("button", { class: "btn small ghost", type: "button", onclick: () => setMember(p.id, true, other) }, `Принять: ${ROLE[other]}`),
      armButton("Отклонить", "Точно отклонить?", () => removeMember(p.id), "btn small ghost danger"));
  } else {
    meta = `Роль: ${ROLE[p.role] || "не задана"}`;
    acts.append(armButton("Отозвать доступ", "Точно отозвать?", () => setMember(p.id, false), "btn small ghost danger"));
  }
  return h("div", { class: "member" }, h("div", null, h("div", { class: "mname" }, p.name || "Без имени"), h("div", { class: "mmeta" }, meta)), acts);
}

function renderMore() {
  if (inactive("more")) return;
  $("#acct").replaceChildren(h("b", null, S.me.name), h("span", null, S.email), h("span", { class: "muted" }, `Роль: ${ROLE[S.me.role]}`));
  renderNotifState();
  if (!isDev()) return;
  const others = Array.from(S.profiles.values()).filter((p) => p.id !== S.uid)
    .sort((a, b) => Number(a.approved) - Number(b.approved) || String(a.name).localeCompare(String(b.name), "ru"));
  $("#members").replaceChildren(...(others.length ? others.map(memberCard) : [h("div", { class: "empty" }, "Других участников пока нет.")]));
  $("#invite-current").textContent = S.settings.invite ? `Сейчас действует слово: ${S.settings.invite}` : "";
}

async function changePassword(e) {
  e.preventDefault();
  const err = $("#pw-error"); err.textContent = "";
  const cur = $("#pw-cur").value, n1 = $("#pw-new").value, n2 = $("#pw-new2").value;
  if (!cur) { err.textContent = "Введите текущий пароль."; return; }
  if (n1.length < 8) { err.textContent = "Новый пароль должен быть не короче 8 символов."; return; }
  if (n1 !== n2) { err.textContent = "Новые пароли не совпадают."; return; }
  if (n1 === cur) { err.textContent = "Новый пароль совпадает со старым."; return; }
  const check = await sb.auth.signInWithPassword({ email: S.email, password: cur });
  if (check.error) { err.textContent = "Текущий пароль неверный."; return; }
  const { error } = await sb.auth.updateUser({ password: n1 });
  if (error) { err.textContent = authError(error); return; }
  e.target.reset();
  toast("Пароль изменён");
}

async function saveInvite(e) {
  e.preventDefault();
  const v = $("#invite-input").value.trim();
  if (v.length < 4) { toast("Кодовое слово должно быть не короче 4 символов"); return; }
  const { error } = await sb.from("settings").upsert({ key: "invite", value: v }, { onConflict: "key" });
  if (error) { toast(errText(error)); return; }
  S.settings.invite = v; $("#invite-input").value = "";
  renderMore(); toast("Кодовое слово сохранено");
}

/* ---------- вход и регистрация ---------- */
async function onLogin(e) {
  e.preventDefault();
  const err = $("#login-error"); err.textContent = "";
  const email = $("#login-email").value.trim(), password = $("#login-pass").value;
  if (!email || !password) { err.textContent = "Введите почту и пароль."; return; }
  try { localStorage.setItem(REMEMBER_KEY, $("#login-remember").checked ? "1" : "0"); } catch { /* ничего */ }
  const btn = e.submitter; if (btn) btn.disabled = true;
  let res;
  try { res = await sb.auth.signInWithPassword({ email, password }); }
  catch (x) { res = { error: x }; }
  if (btn) btn.disabled = false;
  if (res.error) { err.textContent = authError(res.error); return; }
  $("#login-pass").value = "";
  if (res.data?.session) await enter(res.data.session);
}

async function onRegister(e) {
  e.preventDefault();
  const err = $("#reg-error"); err.textContent = "";
  const name = $("#reg-name").value.trim(), email = $("#reg-email").value.trim();
  const role = $('input[name="reg-role"]:checked')?.value || "artist";
  const invite = $("#reg-invite").value.trim(), p1 = $("#reg-pass").value, p2 = $("#reg-pass2").value;
  if (!name) { err.textContent = "Введите имя."; return; }
  if (!email) { err.textContent = "Введите почту."; return; }
  if (!invite) { err.textContent = "Введите кодовое слово."; return; }
  if (p1.length < 8) { err.textContent = "Пароль должен быть не короче 8 символов."; return; }
  if (p1 !== p2) { err.textContent = "Пароли не совпадают."; return; }
  try { localStorage.setItem(REMEMBER_KEY, "0"); } catch { /* ничего */ }
  const btn = e.submitter; if (btn) btn.disabled = true;
  let res;
  try { res = await sb.auth.signUp({ email, password: p1, options: { data: { name, role, invite } } }); }
  catch (x) { res = { error: x }; }
  if (btn) btn.disabled = false;
  if (res.error) { err.textContent = authError(res.error); return; }
  if (!res.data?.session) {
    err.textContent = "Аккаунт создан, но Supabase просит подтвердить почту. Отключите «Confirm email» (руководство, шаг 3) и войдите.";
    return;
  }
  await enter(res.data.session);
}

/* ---------- привязка элементов ---------- */
function bindUI() {
  const selectTab = (reg) => {
    $("#tab-login").setAttribute("aria-selected", String(!reg));
    $("#tab-register").setAttribute("aria-selected", String(reg));
    $("#form-login").hidden = reg; $("#form-register").hidden = !reg;
  };
  $("#tab-login").addEventListener("click", () => selectTab(false));
  $("#tab-register").addEventListener("click", () => selectTab(true));
  $("#form-login").addEventListener("submit", onLogin);
  $("#form-register").addEventListener("submit", onRegister);
  $("#pending-refresh").addEventListener("click", checkApproval);
  $("#pending-logout").addEventListener("click", logout);

  for (const b of $$(".nav button")) b.addEventListener("click", () => setPanel(b.dataset.panel));
  let searchTimer = 0;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.query = e.target.value.trim().toLowerCase(); renderAll(); }, 120);
  });

  const ta = $("#msg-input");
  ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); $("#composer").requestSubmit(); }
  });
  $("#composer").addEventListener("submit", sendMessage);
  $("#reply-cancel").addEventListener("click", () => { S.reply = null; renderReply(); });
  $("#attach-btn").addEventListener("click", () => $("#attach-input").click());
  $("#attach-input").addEventListener("change", (e) => {
    for (const f of e.target.files) {
      try { checkFile(f); S.pending.push(f); } catch (x) { toast(errText(x)); }
    }
    e.target.value = ""; renderChips();
  });
  $("#notif-enable").addEventListener("click", enableNotifications);
  $("#notif-dismiss").addEventListener("click", () => {
    try { localStorage.setItem("sp_notif_dismissed", "1"); } catch { /* ничего */ }
    $("#notif-banner").hidden = true;
  });

  const dz = $("#dropzone");
  $("#pick-btn").addEventListener("click", () => $("#pick-input").click());
  $("#pick-input").addEventListener("change", (e) => uploadMany(e.target.files));
  for (const n of ["dragenter", "dragover"]) dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.add("over"); });
  for (const n of ["dragleave", "drop"]) dz.addEventListener(n, (e) => { e.preventDefault(); dz.classList.remove("over"); });
  dz.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) uploadMany(e.dataTransfer.files); });

  $("#repo-save").addEventListener("click", saveRepo);
  $("#sync-now").addEventListener("click", () => syncReleases(true));
  $("#logout").addEventListener("click", logout);
  $("#notif-toggle").addEventListener("click", enableNotifications);
  $("#form-pass").addEventListener("submit", changePassword);
  $("#form-invite").addEventListener("submit", saveInvite);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !S.me) return;
    if (S.panel === "chat") { S.unread = 0; updateTitle(); markBadge("chat", false); }
    loadAll(true);
  });
  window.addEventListener("online", () => { if (S.me) loadAll(true); });
}

boot();
