const cfg = require('./config');
const { db, nowSec } = require('./db');
const { bar } = require('./embeds');
const { updatePanel } = require('./panel');

// Pesan status queue (ephemeral) milik tiap pemain yang sedang menunggu.
// Disimpan agar bisa di-edit terus selama token interaksi masih berlaku (15 menit).
const waiters = new Map(); // discordId -> { interaction, since, party }

let pending = null; // debounce notifikasi
let ticker = null;

const needPlayers = () => cfg.survivorsPerMatch + 1;
const queueCount = () => db.prepare('SELECT COUNT(*) AS c FROM queue').get().c;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function statusText(w) {
  const need = needPlayers();
  const n = queueCount();
  const who = w.party ? `Party (${w.party} orang) searching sebagai **🏃 Survivor**...` : '🔎 **Searching for match...**';
  return (
    `${who} ⏱️ ${fmtTime(Math.max(0, nowSec() - w.since))}\n` +
    `👥 Queue: **${Math.min(n, need)}/${need}** ${bar(n, need)}\n` +
    (w.party ? 'Maksimal 1 party per match.' : '🎲 Role (🔪 Killer / 🏃 Survivor) diacak saat match ditemukan.') +
    '\n_Pesan ini diperbarui otomatis._'
  );
}

// Channel lobby match aktif milik pemain (kalau ada)
function activeMatchChannel(id) {
  const row = db
    .prepare(
      `SELECT m.channel_id FROM matches m JOIN match_players p ON p.match_id = m.id
       WHERE p.discord_id=? AND m.status='active' ORDER BY m.id DESC LIMIT 1`
    )
    .get(id);
  return row && row.channel_id ? `<#${row.channel_id}>` : null;
}

// Daftarkan pemain sebagai penunggu; mengembalikan teks status awal untuk dikirim sebagai balasan.
function registerWaiter(id, interaction, opts = {}) {
  const old = waiters.get(id);
  if (old && old.interaction !== interaction) {
    old.interaction.editReply('↪️ Queue diperbarui. Lihat pesan status yang terbaru.').catch(() => {});
  }
  const w = { interaction, since: nowSec(), party: opts.party || 0 };
  waiters.set(id, w);
  return statusText(w);
}

async function refreshWaiters() {
  for (const [id, w] of [...waiters]) {
    try {
      const inQueue = db.prepare('SELECT 1 FROM queue WHERE discord_id=?').get(id);
      if (inQueue) {
        await w.interaction.editReply(statusText(w));
      } else {
        const ch = activeMatchChannel(id);
        await w.interaction.editReply(ch ? `🔥 **Match ditemukan!** Masuk ke ${ch}.` : '❌ Kamu sudah tidak di queue.');
        waiters.delete(id);
      }
    } catch {
      // token interaksi kedaluwarsa / pesan di-dismiss: berhenti memperbarui pemain ini
      waiters.delete(id);
    }
  }
}

// Panggil setiap kali isi queue berubah (join, leave, match terbentuk).
// Digabung (debounce) supaya tidak terlalu sering mengedit pesan.
function notifyQueueChanged(client) {
  if (pending) return;
  pending = setTimeout(async () => {
    pending = null;
    await refreshWaiters();
    await updatePanel(client);
  }, 1200);
}

// Jalankan sekali saat bot siap: segarkan panel dan perbarui timer menunggu tiap 10 detik
function startLive(client) {
  if (ticker) return;
  updatePanel(client, true);
  ticker = setInterval(async () => {
    if (waiters.size) await refreshWaiters();
    await updatePanel(client);
  }, 10000);
}

module.exports = { registerWaiter, notifyQueueChanged, startLive };
