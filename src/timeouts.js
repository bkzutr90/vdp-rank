const cfg = require('./config');
const { db, nowSec } = require('./db');
const { voidMatch, disputeMatch } = require('./matches');

// Dipanggil berkala: ingatkan pemain, lalu void / dispute match yang tidak disubmit
async function sweepMatches(client) {
  const now = nowSec();
  const rows = db.prepare("SELECT * FROM matches WHERE status='active'").all();

  for (const m of rows) {
    try {
      const age = now - m.created_at;

      if (age >= cfg.matchTimeoutMin * 60) {
        const votes = db.prepare('SELECT COUNT(*) AS c FROM match_players WHERE match_id=? AND vote IS NOT NULL').get(m.id).c;
        if (votes === 0) {
          await voidMatch(
            client,
            m.id,
            `⏱️ Tidak ada hasil yang disubmit dalam ${cfg.matchTimeoutMin} menit. Match di-void otomatis, MMR tidak berubah.`
          );
        } else {
          await disputeMatch(client, m.id, `Timeout ${cfg.matchTimeoutMin} menit: hasil belum disepakati (${votes} vote masuk)`);
        }
        continue;
      }

      if (age >= cfg.matchReminderMin * 60 && !m.reminded) {
        db.prepare('UPDATE matches SET reminded=1 WHERE id=?').run(m.id);
        const pending = db.prepare('SELECT discord_id FROM match_players WHERE match_id=? AND vote IS NULL').all(m.id);
        if (m.channel_id && pending.length) {
          const ch = await client.channels.fetch(m.channel_id).catch(() => null);
          if (ch) {
            const left = cfg.matchTimeoutMin - cfg.matchReminderMin;
            await ch.send(
              `⏰ ${pending.map((p) => `<@${p.discord_id}>`).join(' ')} — belum submit hasil. ` +
                `Tekan tombol pemenang di atas. Sisa waktu sekitar **${left} menit**, setelah itu match di-void/dispute otomatis.`
            );
          }
        }
      }
    } catch (err) {
      console.warn(`[timeouts] gagal memproses match ${m.id}:`, err.message);
    }
  }
}

module.exports = { sweepMatches };
