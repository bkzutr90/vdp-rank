const TIERS = [
  { name: 'Bronze', emoji: '🥉', color: '#cd7f32', min: 0, max: 999 },
  { name: 'Silver', emoji: '🥈', color: '#c0c7d1', min: 1000, max: 1199 },
  { name: 'Gold', emoji: '🥇', color: '#ffd24a', min: 1200, max: 1399 },
  { name: 'Platinum', emoji: '💎', color: '#4fd6c8', min: 1400, max: 1599 },
  { name: 'Diamond', emoji: '🔥', color: '#4aa8ff', min: 1600, max: 1799 },
  { name: 'Master', emoji: '👑', color: '#b36bff', min: 1800, max: 1999 },
  { name: 'Grandmaster', emoji: '☠️', color: '#ff4d4d', min: 2000, max: Infinity },
];

const DIVISIONS = ['I', 'II', 'III']; // I = bawah, III = atas tier

function getRank(mmr) {
  const tier = [...TIERS].reverse().find((t) => mmr >= t.min) || TIERS[0];
  let division = '';
  if (tier.max !== Infinity) {
    const size = (tier.max - tier.min + 1) / 3;
    const idx = Math.min(2, Math.floor((mmr - tier.min) / size));
    division = DIVISIONS[idx];
  }
  return {
    tier,
    division,
    label: `${tier.emoji} ${tier.name}${division ? ' ' + division : ''}`,
  };
}

// Probabilitas menang A melawan B (Elo)
function expected(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

module.exports = { TIERS, getRank, expected };
