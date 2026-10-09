const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const cfg = require('./config');
const { db } = require('./db');
const { bar } = require('./embeds');

const needPlayers = () => cfg.survivorsPerMatch + 1;
const queueCount = () => db.prepare('SELECT COUNT(*) AS c FROM queue').get().c;
const activeCount = () => db.prepare("SELECT COUNT(*) AS c FROM matches WHERE status='active'").get().c;

// Isi panel Ranked Queue (embed + tombol), lengkap dengan status queue saat ini
function panelPayload() {
  const need = needPlayers();
  const queue = queueCount();
  const active = activeCount();

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('🔥 VDP RANKED')
    .setDescription(
      'Tekan **Join Queue**, lalu tunggu match ditemukan.\n\n' +
        '**Format:** 1 🔪 Killer vs 4 🏃 Survivor\n' +
        '**Role:** diacak otomatis saat match ditemukan 🎲\n' +
        '**Wajib:** akun Roblox terverifikasi (`/verify`)\n' +
        '**Party:** `/party create` → `/party invite` → leader tekan **Party Queue** (party selalu jadi Survivor)\n\n' +
        'Rating Killer & Survivor dihitung **terpisah**. Menang/kalah juga memberi **Ranked Points**.'
    )
    .addFields({
      name: '📡 Status Live',
      value: `🔎 Di queue: **${Math.min(queue, need)}/${need}** ${bar(queue, need)}\n🎮 Match berlangsung: **${active}**`,
    })
    .setFooter({ text: 'Status diperbarui otomatis' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('q:join').setLabel('🎮 Join Queue').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('q:party').setLabel('👥 Party Queue').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('q:leave').setLabel('❌ Leave Queue').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('q:rank').setLabel('📊 My Rank').setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [row] };
}

// ------------------------------------------------------------------ lokasi panel (disimpan di tabel settings)
function savePanel(channelId, messageId) {
  const up = db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  up.run('panel_channel', String(channelId));
  up.run('panel_message', String(messageId));
  lastKey = '';
}

function getPanel() {
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
  const channelId = get('panel_channel');
  const messageId = get('panel_message');
  return channelId && messageId ? { channelId, messageId } : null;
}

function clearPanel() {
  db.prepare("DELETE FROM settings WHERE key IN ('panel_channel','panel_message')").run();
}

// Edit pesan panel hanya kalau angka queue / match aktif berubah (hemat rate limit)
let lastKey = '';
async function updatePanel(client, force = false) {
  const p = getPanel();
  if (!p) return;
  const key = `${queueCount()}:${activeCount()}`;
  if (!force && key === lastKey) return;
  lastKey = key;

  try {
    const channel = await client.channels.fetch(p.channelId);
    const message = await channel.messages.fetch(p.messageId);
    await message.edit(panelPayload());
  } catch (err) {
    // 10003 = channel hilang, 10008 = pesan dihapus: lupakan panel itu
    if (err.code === 10003 || err.code === 10008) clearPanel();
    else console.warn('[panel] gagal update panel:', err.message);
  }
}

module.exports = { panelPayload, savePanel, getPanel, updatePanel };
