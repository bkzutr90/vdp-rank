require('dotenv').config();

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  dbPath: process.env.DB_PATH || './data/vdp-ranked.sqlite',

  adminChannelId: process.env.ADMIN_CHANNEL_ID || null,
  announceChannelId: process.env.ANNOUNCE_CHANNEL_ID || null,
  categoryId: process.env.MATCH_CATEGORY_ID || null,
  modRoleId: process.env.MOD_ROLE_ID || null,
  requireVerify: (process.env.REQUIRE_VERIFY || 'true') === 'true',

  // Rating
  startMmr: 1000,
  placementGames: 10, // per role (Killer / Survivor)
  k: 32, // placement otomatis K x2
  seasonCarry: 0.5, // soft reset: 50% jarak dari startMmr dibawa ke season baru

  // Ranked Points (RP) - terpisah dari MMR
  rpWin: 100,
  rpLoss: 30,
  rpStreakBonus: 20, // bonus saat menang dengan win streak >= rpStreakMin
  rpStreakMin: 3,

  // Format match: 1 Killer vs 4 Survivor
  survivorsPerMatch: 4,
  votesNeeded: 3, // minimal 3 dari 5 pemain sepakat -> hasil terverifikasi

  // Party (hanya sisi Survivor; Killer selalu solo)
  maxPartySize: 4,
  partyMmrBonus: 25, // MMR efektif party = rata-rata + (ukuran - 1) * bonus ini

  // Matchmaking: selisih MMR yang diizinkan makin lebar kalau antre lama
  baseRange: 200,
  rangePerSecond: 5,
  maxRange: 1500,
  matchmakingIntervalMs: 10000,

  // Timeout match yang tidak disubmit
  matchReminderMin: 30, // ingatkan pemain yang belum vote
  matchTimeoutMin: 90, // 0 vote -> void otomatis; ada vote tapi belum sepakat -> dispute
  sweepIntervalMs: 60000,

  // Deteksi win trading / boosting antar pasangan pemain
  pairWindowDays: 14,
  pairMinMeetings: 4, // minimal bertemu (sisi berlawanan) sebanyak ini dalam jendela waktu
  pairLopsided: 0.8, // salah satu menang >= 80% dari pertemuan -> mencurigakan
  pairAlertCooldownHours: 24,

  lobbyDeleteMs: 120000, // channel lobby dihapus 2 menit setelah hasil terverifikasi
};
