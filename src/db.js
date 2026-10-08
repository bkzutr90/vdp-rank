const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { expected } = require('./ranks');

fs.mkdirSync(path.dirname(path.resolve(cfg.dbPath)), { recursive: true });
const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  roblox_id TEXT UNIQUE NOT NULL,
  roblox_name TEXT NOT NULL,
  verified_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS verify_pending (
  discord_id TEXT PRIMARY KEY,
  roblox_id TEXT NOT NULL,
  roblox_name TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS stats (
  discord_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  role TEXT NOT NULL,
  mmr INTEGER NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  games INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  peak INTEGER NOT NULL,
  PRIMARY KEY (discord_id, season, role)
);

CREATE TABLE IF NOT EXISTS queue (
  discord_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  party_id INTEGER,
  joined_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL,
  status TEXT NOT NULL,           -- active | disputed | verified | void
  killer_id TEXT NOT NULL,
  channel_id TEXT,
  winner TEXT,                    -- killer | survivor
  killer_mmr REAL,
  surv_avg REAL,
  reminded INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id INTEGER NOT NULL,
  discord_id TEXT NOT NULL,
  role TEXT NOT NULL,
  vote TEXT,
  mmr_before INTEGER,
  mmr_after INTEGER,
  delta INTEGER,
  rp INTEGER DEFAULT 0,
  PRIMARY KEY (match_id, discord_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter TEXT NOT NULL,
  target TEXT NOT NULL,
  category TEXT NOT NULL,
  details TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS hall_of_fame (
  season INTEGER NOT NULL,
  title TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  mmr INTEGER
);

CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leader_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS party_members (
  discord_id TEXT PRIMARY KEY,
  party_id INTEGER NOT NULL,
  joined_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS rp (
  discord_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (discord_id, season)
);

CREATE TABLE IF NOT EXISTS frozen (
  discord_id TEXT PRIMARY KEY,
  reason TEXT,
  by TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
`);

// Migrasi untuk database dari versi sebelumnya
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('queue', 'party_id', 'INTEGER');
addColumn('match_players', 'rp', 'INTEGER DEFAULT 0');
addColumn('matches', 'reminded', 'INTEGER DEFAULT 0');

const matchTag = (id) => `VD-RANKED #${String(id).padStart(6, '0')}`;
const nowSec = () => Math.floor(Date.now() / 1000);

function getSeason() {
  const row = db.prepare("SELECT value FROM settings WHERE key='season'").get();
  return row ? Number(row.value) : 1;
}

function setSeason(n) {
  db.prepare("INSERT INTO settings (key,value) VALUES ('season',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));
}

// Ambil stat per role di season tertentu (dibuat otomatis, dengan soft reset dari season lalu)
function getStat(id, role, season = getSeason()) {
  const find = () => db.prepare('SELECT * FROM stats WHERE discord_id=? AND season=? AND role=?').get(id, season, role);
  let s = find();
  if (s) return s;
  const prev = db
    .prepare('SELECT mmr FROM stats WHERE discord_id=? AND role=? AND season<? ORDER BY season DESC LIMIT 1')
    .get(id, role, season);
  const mmr = prev ? Math.round(cfg.startMmr + (prev.mmr - cfg.startMmr) * cfg.seasonCarry) : cfg.startMmr;
  db.prepare('INSERT INTO stats (discord_id,season,role,mmr,peak) VALUES (?,?,?,?,?)').run(id, season, role, mmr, mmr);
  return find();
}

// MMR keseluruhan = rata-rata role yang sudah pernah dimainkan
function overall(id) {
  const k = getStat(id, 'killer');
  const s = getStat(id, 'survivor');
  const played = [k, s].filter((x) => x.games > 0);
  const mmr = played.length ? Math.round(played.reduce((a, x) => a + x.mmr, 0) / played.length) : cfg.startMmr;
  const unranked = !(k.games >= cfg.placementGames || s.games >= cfg.placementGames);
  return { mmr, unranked, games: k.games + s.games };
}

// ------------------------------------------------------------------ Ranked Points
function getRp(id, season = getSeason()) {
  const cur = db.prepare('SELECT points FROM rp WHERE discord_id=? AND season=?').get(id, season);
  const tot = db.prepare('SELECT COALESCE(SUM(points),0) AS t FROM rp WHERE discord_id=?').get(id);
  return { season: cur ? cur.points : 0, total: tot.t };
}

// ------------------------------------------------------------------ Freeze MMR
const isFrozen = (id) => db.prepare('SELECT * FROM frozen WHERE discord_id=?').get(id);

function setFrozen(id, reason, by) {
  db.prepare(
    `INSERT INTO frozen (discord_id, reason, by) VALUES (?,?,?)
     ON CONFLICT(discord_id) DO UPDATE SET reason=excluded.reason, by=excluded.by, created_at=strftime('%s','now')`
  ).run(id, reason || '-', by || null);
  removeFromQueue(id);
}

const clearFrozen = (id) => db.prepare('DELETE FROM frozen WHERE discord_id=?').run(id).changes;

// ------------------------------------------------------------------ Queue helper
// Kalau pemain antre sebagai bagian party, seluruh party ikut keluar dari queue
function removeFromQueue(id) {
  const row = db.prepare('SELECT party_id FROM queue WHERE discord_id=?').get(id);
  if (!row) return 0;
  if (row.party_id) return db.prepare('DELETE FROM queue WHERE party_id=?').run(row.party_id).changes;
  return db.prepare('DELETE FROM queue WHERE discord_id=?').run(id).changes;
}

// Cegah alert yang sama dikirim berulang
function shouldAlert(key, cooldownHours) {
  const now = nowSec();
  const row = db.prepare('SELECT created_at FROM alerts WHERE key=?').get(key);
  if (row && now - row.created_at < cooldownHours * 3600) return false;
  db.prepare('INSERT INTO alerts (key, created_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET created_at=excluded.created_at').run(key, now);
  return true;
}

/**
 * Finalisasi match secara atomik (anti double-process).
 * Mengembalikan null kalau match sudah diproses / void.
 */
const finalizeMatch = db.transaction((matchId, winner) => {
  const m = db.prepare('SELECT * FROM matches WHERE id=?').get(matchId);
  if (!m || !['active', 'disputed'].includes(m.status)) return null;

  const players = db.prepare('SELECT * FROM match_players WHERE match_id=?').all(matchId);
  const killer = players.find((p) => p.role === 'killer');
  const survs = players.filter((p) => p.role === 'survivor');

  const kStat = getStat(killer.discord_id, 'killer', m.season);
  const sStats = survs.map((p) => getStat(p.discord_id, 'survivor', m.season));
  const survAvg = sStats.reduce((a, s) => a + s.mmr, 0) / sStats.length;

  const E = expected(kStat.mmr, survAvg); // peluang menang Killer
  const killerWon = winner === 'killer' ? 1 : 0;
  const results = [];

  const apply = (id, role, stat, delta, won) => {
    const before = overall(id);

    // MMR dibekukan: hasil dicatat tapi MMR/RP tidak berubah
    if (isFrozen(id)) {
      db.prepare('UPDATE match_players SET mmr_before=?, mmr_after=?, delta=0, rp=0 WHERE match_id=? AND discord_id=?').run(
        stat.mmr,
        stat.mmr,
        matchId,
        id
      );
      results.push({ discord_id: id, role, before, after: before, delta: 0, mmr: stat.mmr, won, streak: stat.streak, rp: 0, frozen: true });
      return;
    }

    const newMmr = Math.max(0, stat.mmr + delta);
    const real = newMmr - stat.mmr;
    const streak = won ? Math.max(stat.streak, 0) + 1 : 0;
    db.prepare(
      'UPDATE stats SET mmr=?, wins=wins+?, losses=losses+?, streak=?, peak=MAX(peak,?), games=games+1 WHERE discord_id=? AND season=? AND role=?'
    ).run(newMmr, won ? 1 : 0, won ? 0 : 1, streak, newMmr, id, m.season, role);

    const rpGain = won ? cfg.rpWin + (streak >= cfg.rpStreakMin ? cfg.rpStreakBonus : 0) : cfg.rpLoss;
    db.prepare(
      'INSERT INTO rp (discord_id, season, points) VALUES (?,?,?) ON CONFLICT(discord_id, season) DO UPDATE SET points=points+excluded.points'
    ).run(id, m.season, rpGain);

    db.prepare('UPDATE match_players SET mmr_before=?, mmr_after=?, delta=?, rp=? WHERE match_id=? AND discord_id=?').run(
      stat.mmr,
      newMmr,
      real,
      rpGain,
      matchId,
      id
    );
    const after = overall(id);
    results.push({ discord_id: id, role, before, after, delta: real, mmr: newMmr, won, streak, rp: rpGain, frozen: false });
  };

  const kK = kStat.games < cfg.placementGames ? cfg.k * 2 : cfg.k;
  apply(killer.discord_id, 'killer', kStat, Math.round(kK * (killerWon - E)), killerWon === 1);

  survs.forEach((p, i) => {
    const st = sStats[i];
    const K = st.games < cfg.placementGames ? cfg.k * 2 : cfg.k;
    // peluang menang survivor = 1 - E
    apply(p.discord_id, 'survivor', st, Math.round(K * (1 - killerWon - (1 - E))), killerWon === 0);
  });

  db.prepare("UPDATE matches SET status='verified', winner=?, killer_mmr=?, surv_avg=?, finished_at=strftime('%s','now') WHERE id=?").run(
    winner,
    kStat.mmr,
    survAvg,
    matchId
  );

  return { match: m, winner, results };
});

module.exports = {
  db,
  matchTag,
  nowSec,
  getSeason,
  setSeason,
  getStat,
  overall,
  getRp,
  isFrozen,
  setFrozen,
  clearFrozen,
  removeFromQueue,
  shouldAlert,
  finalizeMatch,
};
